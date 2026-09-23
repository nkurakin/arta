// ============================================================================
// climate_ctrl.js — скрипт правил wb-rules (Wiren Board): термостат камеры
// ----------------------------------------------------------------------------
// Вход:  параметры с топиков wb/climate/set/* (публикует climate_ui.js)
//          Mode, Manual, TargetTemp, Hysteresis
//        температуры RS-485 (wb-mqtt-serial):
//          wb-mai6_28/IN 1 N Temperature  — датчик низ   камеры
//          wb-mai6_28/IN 2 P Temperature  — датчик верх  камеры
//          wb-mai6_28/IN 1 P Temperature  — переносной термометр (резерв)
// Выход: команда на реле компрессора WB-WRM2:  wb-mrwm2_134/K1
//        обратная связь термостата в UI:       wb/climate/fb/CompressorCommand
//
// Логика:
//   1. Mode = OFF(0)                 -> Command = 0 (компрессор обесточен).
//   2. Mode = AUTO(1), Manual=ON(1)  -> ручной режим: Command = 1 постоянно
//      (с учётом задержки минимального простоя при включении).
//   3. Mode = AUTO(1), Manual=OFF(0) -> автоматический термостат:
//      T = среднее(низ, верх); если оба недоступны — переносной датчик;
//      включение:  T > TargetTemp + Hysteresis
//      выключение: T < TargetTemp - Hysteresis
//   4. Защита компрессора: не чаще одного переключения в MIN_OFF_SEC (простой)
//      и не короче MIN_ON_SEC (минимальный цикл включения).
//   5. Авария: если все внутренние датчики молчат более STALE_SEC секунд —
//      Command = 0, логирование ошибки.
//
// Размещение: /etc/wb-rules/climate_ctrl.js (wb-rules перезагрузит файл сам).
// Зависимостей от npm-пакетов нет — только API wb-rules.
// Стиль: ES5 (движок wb-rules — Duktape), без trailing-запятых.
// getEnvironment() в wb-rules отсутствует — настройки задаются константами ниже.
// ============================================================================

"use strict";

// ---- настройки (редактируются прямо здесь) ---------------------------------
var MIN_ON_SEC  = 180; // минимальное время работы компрессора, сек
var MIN_OFF_SEC = 180; // минимальное время простоя компрессора, сек
var STALE_SEC   = 60;  // датчик считается потерянным после молчания, сек

// ---- внутреннее состояние --------------------------------------------------
var params = {
    Mode: 0,
    Manual: 0,
    TargetTemp: 5.0,
    Hysteresis: 0.5
};

var temps = {
    // последние значения температур и unix-время прихода, сек (null — не было)
    bottom:   { v: null, t: null },
    top:      { v: null, t: null },
    portable: { v: null, t: null }
};

var command    = 0;  // текущая команда термостата (0/1)
var lastSwitch = 0;  // unix-время последнего изменения команды, сек
var errorState = false;

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Приём параметров от climate_ui.js (топики wb/climate/set/<Param>, retained).
// Топики содержат слэши — подписка через when(match) c обратным вызовом.
// ---------------------------------------------------------------------------
["Mode", "Manual", "TargetTemp", "Hysteresis"].forEach(function (name) {
    defineRule("climate_ctrl_set_" + name, {
        when: function (match) {
            return match("/wb/climate/set/" + name);
        },
        then: function (topic, message) {
            var v = NaN;
            try {
                v = parseFloat(String(message));
            } catch (e) {
                return;
            }
            if (isNaN(v)) return;
            var old = params[name];
            params[name] = v;
            log.info("climate_ctrl: параметр {} = {} (было {})", name, v, old);
            evaluate();
        }
    });
});

// ---------------------------------------------------------------------------
// Приём температур (wb-rules нотация device/channel, пробелы в именах каналов)
// ---------------------------------------------------------------------------
[
    ["bottom",   "wb-mai6_28/IN 1 N Temperature"],
    ["top",      "wb-mai6_28/IN 2 P Temperature"],
    ["portable", "wb-mai6_28/IN 1 P Temperature"]
].forEach(function (pair) {
    defineRule("climate_ctrl_temp_" + pair[0], {
        whenChanged: pair[1],
        then: function (newValue) {
            var v = Number(newValue);
            if (newValue === null || newValue === undefined || isNaN(v)) return;
            temps[pair[0]] = { v: v, t: nowSec() };
            evaluate();
        }
    });
});

// ---------------------------------------------------------------------------
// Измерение текущей температуры камеры: среднее(низ, верх),
// резерв — переносной датчик. Возвращает null, если данных нет/они устарели.
// ---------------------------------------------------------------------------
function fresh(entry) {
    return entry.v !== null && entry.t !== null &&
           (nowSec() - entry.t) <= STALE_SEC;
}

function measureTemperature() {
    var b = fresh(temps.bottom) ? temps.bottom.v : null;
    var t = fresh(temps.top) ? temps.top.v : null;
    if (b !== null && t !== null) return (b + t) / 2;
    if (b !== null) return b;
    if (t !== null) return t;
    if (fresh(temps.portable)) return temps.portable.v;
    return null;
}

// ---------------------------------------------------------------------------
// Основная функция термостата: вычисляет команду и публикует её
// ---------------------------------------------------------------------------
function setCommand(newCmd) {
    if (newCmd === command) return;
    var elapsed = nowSec() - lastSwitch;
    if (command === 1 && elapsed < MIN_ON_SEC) {
        log.debug("climate_ctrl: переключение заблокировано (MIN_ON_SEC)");
        return;
    }
    if (command === 0 && elapsed < MIN_OFF_SEC) {
        log.debug("climate_ctrl: переключение заблокировано (MIN_OFF_SEC)");
        return;
    }
    command = newCmd;
    lastSwitch = nowSec();
    publish("wb-mrwm2_134/K1", String(command), { qos: 1, retain: true });
    publish("wb/climate/fb/CompressorCommand", String(command),
            { qos: 0, retain: true });
    log.info("climate_ctrl: команда компрессору = {}", command);
}

function evaluate() {
    var target = params.TargetTemp;
    var hyst   = params.Hysteresis;

    // 1. Режим OFF
    if (!params.Mode) {
        setCommand(0);
        return;
    }

    // 2. Ручной режим (Manual ON при AUTO режиме) — принудительное включение
    if (params.Manual) {
        errorState = false;
        setCommand(1);
        return;
    }

    // 3. Автоматический термостат
    var t = measureTemperature();
    if (t === null) {
        if (!errorState) {
            errorState = true;
            log.error("climate_ctrl: нет свежих данных температур -> аварийное выключение");
        }
        setCommand(0);
        return;
    }
    errorState = false;

    if (command === 0 && t > target + hyst) {
        setCommand(1);
    } else if (command === 1 && t < target - hyst) {
        setCommand(0);
    }
    // в зоне гистерезиса команда не меняется
}

// ---------------------------------------------------------------------------
// Периодический контроль: устаревание данных и снятие блокировок таймеров
// ---------------------------------------------------------------------------
defineRule("climate_ctrl_loop", {
    cron: "* * * * * *", // каждую секунду
    then: function () {
        evaluate();
    }
});

// ---------------------------------------------------------------------------
// Безопасная позиция при старте правил: команда 0.
// then:false — правило НЕ выполняется автоматически при загрузке;
// itIsTooComplexForNotifyChanges — разрешает dev/publish в then.
// Реальный запуск — по timer() ниже, чтобы wb-mqtt-serial успел
// восстановить состояние реле из retained-топиков.
// ---------------------------------------------------------------------------
defineRule("climate_ctrl_init", {
    whenChanged: "climate_ui/Mode",
    then: false,
    itIsTooComplexForNotifyChanges: true
});

timer(function () {
    command = 0;
    lastSwitch = nowSec();
    publish("wb-mrwm2_134/K1", "0", { qos: 1, retain: true });
    publish("wb/climate/fb/CompressorCommand", "0", { qos: 0, retain: true });
    log.info("climate_ctrl: инициализация, безопасная позиция. MIN_ON={}s MIN_OFF={}s STALE={}s",
             MIN_ON_SEC, MIN_OFF_SEC, STALE_SEC);
    // retained-параметры из wb/climate/set/* будут доставлены брокером
    // автоматически; далее их подтянет evaluate() из цикла cron
}, 5000);

log.info("climate_ctrl: правила загружены");
