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
//   1. Mode = OFF(0)            -> Command = 0 (компрессор обесточен).
//   2. Mode = AUTO(1), Manual=ON(1) -> ручной режим: Command = 1 постоянно
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
// Размещение: /etc/wb-rules/climate_ctrl.js (wb-rules перезагрузит сам).
// Зависимостей от npm-пакетов нет — только API wb-rules.
// ============================================================================

// ---- настройки (можно менять прямо здесь или через переменные окружения) ---
var MIN_ON_SEC  = Number(getEnvironment("CLIMATE_MIN_ON_SEC")  || 180); // мин. время работы компрессора
var MIN_OFF_SEC = Number(getEnvironment("CLIMATE_MIN_OFF_SEC") || 180); // мин. время простоя
var STALE_SEC   = Number(getEnvironment("CLIMATE_STALE_SEC")   || 60);  // датчик считается потерянным

// ---- внутреннее состояние --------------------------------------------------
var params = {
    Mode: 0,
    Manual: 0,
    TargetTemp: 5.0,
    Hysteresis: 0.5,
};

var temps = {          // последние значения температур и время прихода (мс)
    bottom:   { v: null, t: 0 },
    top:      { v: null, t: 0 },
    portable: { v: null, t: 0 },
};

var command     = 0;   // текущая команда термостата (0/1)
var lastSwitch  = 0;   // время последнего изменения команды, мс
var errorState  = false;

// ---------------------------------------------------------------------------
// Приём параметров от climate_ui.js (топики wb/climate/set/*, retained)
// ---------------------------------------------------------------------------
Object.keys(params).forEach(function (name) {
    defineRule("climate_ctrl_set_" + name, {
        when: new RegExp("^wb/climate/set/" + name + "$"),
        then: function (message) {
            var v = parseFloat(message.message.toString());
            if (isNaN(v)) return;
            var old = params[name];
            params[name] = v;
            log.info("climate_ctrl: параметр {} = {} (было {})", name, v, old);
            evaluate();
        },
    });
});

// ---------------------------------------------------------------------------
// Приём температур (wb-rules нотация device/channel)
// ---------------------------------------------------------------------------
defineRule("climate_ctrl_temp_bottom", {
    whenChanged: "wb-mai6_28/IN 1 N Temperature",
    then: function (newValue) {
        var v = Number(newValue);
        if (newValue === null || isNaN(v)) return;
        temps.bottom = { v: v, t: now() };
        evaluate();
    },
});

defineRule("climate_ctrl_temp_top", {
    whenChanged: "wb-mai6_28/IN 2 P Temperature",
    then: function (newValue) {
        var v = Number(newValue);
        if (newValue === null || isNaN(v)) return;
        temps.top = { v: v, t: now() };
        evaluate();
    },
});

defineRule("climate_ctrl_temp_portable", {
    whenChanged: "wb-mai6_28/IN 1 P Temperature",
    then: function (newValue) {
        var v = Number(newValue);
        if (newValue === null || isNaN(v)) return;
        temps.portable = { v: v, t: now() };
        evaluate();
    },
});

// ---------------------------------------------------------------------------
// Измерение текущей температуры камеры: среднее(низ, верх), резерв — портативный
// Возвращает null, если данных нет / они устарели
// ---------------------------------------------------------------------------
function fresh(entry) {
    return entry.v !== null && (now() - entry.t) <= STALE_SEC * 1000;
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
    var elapsed = (now() - lastSwitch) / 1000;
    if (command === 1 && elapsed < MIN_ON_SEC) {
        log.debug("climate_ctrl: переключение заблокировано (MIN_ON_SEC)");
        scheduleRecheck(MIN_ON_SEC - elapsed + 1);
        return;
    }
    if (command === 0 && elapsed < MIN_OFF_SEC) {
        log.debug("climate_ctrl: переключение заблокировано (MIN_OFF_SEC)");
        scheduleRecheck(MIN_OFF_SEC - elapsed + 1);
        return;
    }
    command = newCmd;
    lastSwitch = now();
    publish("wb-mrwm2_134/K1", String(command), { qos: 1, retain: true });
    publish("wb/climate/fb/CompressorCommand", String(command),
            { qos: 0, retain: true });
    log.info("climate_ctrl: команда компрессору = {}", command);
}

var recheckTimer = null;
function scheduleRecheck(sec) {
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(function () {
        recheckTimer = null;
        evaluate();
    }, sec * 1000);
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
    },
});

// ---------------------------------------------------------------------------
// Безопасная позиция при старте правил: OFF, команда 0
// ---------------------------------------------------------------------------
defineRule("climate_ctrl_init", {
    runAtStartup: {
        time: "2s", // дать wb-mqtt-serial опросить модули
        firstTimeOnly: false,
    },
    then: function () {
        command = 0;
        lastSwitch = now();
        publish("wb-mrwm2_134/K1", "0", { qos: 1, retain: true });
        publish("wb/climate/fb/CompressorCommand", "0", { qos: 0, retain: true });
        log.info("climate_ctrl: инициализация, безопасная позиция OFF. " +
                 "MIN_ON={}s MIN_OFF={}s STALE={}s", MIN_ON_SEC, MIN_OFF_SEC, STALE_SEC);
        // evaluate подтянет retained-параметры из wb/climate/set/* автоматически
    },
});

log.info("climate_ctrl: правила загружены");
