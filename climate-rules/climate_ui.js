// ============================================================================
// climate_ui.js — скрипт правил wb-rules (Wiren Board)
// ----------------------------------------------------------------------------
// Создаёт виртуальное устройство "climate_ui" с параметрами управления
// климатической камерой:
//   Mode              switch  (RW)  0=OFF, 1=AUTO      — режим работы
//   Manual            switch  (RW)  0=OFF, 1=ON        — ручной режим
//   TargetTemp        value   (RW)  °C                 — уставка температуры
//   Hysteresis        value   (RW)  °C                 — гистерезис уставки
//   CompressorCommand switch  (RO)  0/1                — выход термостата
// Индикация температур (read-only):
//   TempBottom    — датчик низ     (wb-mai6_28/IN 1 N Temperature)
//   TempTop       — датчик верх    (wb-mai6_28/IN 2 P Temperature)
//   TempPortable  — переносной     (wb-mai6_28/IN 1 P Temperature)
//   TempExternal  — внешний        (wb-mai6_28/Internal Temperature)
// Фактическое состояние реле компрессора:
//   CompressorActual — wb-mrwm2_134/K1
//
// Взаимодействие со скриптом термостата climate_ctrl.js — через MQTT-топики
// внутреннего канала контроллера (localhost:1883):
//   wb/climate/set/<Param>          ui -> ctrl (команды параметров, retained)
//   wb/climate/fb/CompressorCommand ctrl -> ui (выход термостата, retained)
//
// Размещение: /etc/wb-rules/climate_ui.js (wb-rules перезагрузит файл сам).
// Зависимостей от npm-пакетов нет — только API wb-rules.
// Стиль: ES5 (движок wb-rules — Duktape), без trailing-запятых.
// ============================================================================

"use strict";

defineVirtualDevice("climate_ui", {
    title: "Climate Chamber UI",
    cells: {
        // ---- органы управления (RW) ------------------------------------
        Mode: {
            title: "Режим работы (0=OFF, 1=AUTO)",
            type: "switch",
            value: 0,
            forceDefault: true // при старте всегда OFF — безопасная позиция
        },
        Manual: {
            title: "Ручной режим (0=OFF, 1=ON)",
            type: "switch",
            value: 0,
            forceDefault: true
        },
        TargetTemp: {
            title: "Целевая температура, °C",
            type: "value",
            value: 5.0,
            min: -40,
            max: 150,
            readonly: false,
            units: "unit:c"
        },
        Hysteresis: {
            title: "Гистерезис, °C",
            type: "value",
            value: 0.5,
            min: 0.1,
            max: 10,
            readonly: false,
            units: "unit:c"
        },

        // ---- выход термостата (RO, обновляется из climate_ctrl.js) ------
        CompressorCommand: {
            title: "Команда термостата на компрессор (RO)",
            type: "switch",
            value: 0,
            readonly: true
        },

        // ---- фактическое состояние реле WB-WRM2 (RO) --------------------
        CompressorActual: {
            title: "Фактическое состояние реле K1 (RO)",
            type: "switch",
            value: 0,
            readonly: true
        },

        // ---- индикация температур (RO) ----------------------------------
        TempBottom: {
            title: "Температура в камере, низ (RO)",
            type: "value",
            value: null,
            readonly: true,
            units: "unit:c"
        },
        TempTop: {
            title: "Температура в камере, верх (RO)",
            type: "value",
            value: null,
            readonly: true,
            units: "unit:c"
        },
        TempPortable: {
            title: "Переносной термометр в камере (RO)",
            type: "value",
            value: null,
            readonly: true,
            units: "unit:c"
        },
        TempExternal: {
            title: "Температура снаружи камеры (RO)",
            type: "value",
            value: null,
            readonly: true,
            units: "unit:c"
        }
    }
});

// ---------------------------------------------------------------------------
// Публикация изменений RW-параметров для скрипта термостата (wb/climate/set/*)
// ---------------------------------------------------------------------------
["Mode", "Manual", "TargetTemp", "Hysteresis"].forEach(function (name) {
    defineRule("climate_ui_publish_" + name, {
        whenChanged: "climate_ui/" + name,
        then: function (newValue) {
            if (newValue === null || newValue === undefined) return;
            publish("wb/climate/set/" + name, String(newValue),
                    { qos: 0, retain: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Приём выхода термостата из climate_ctrl.js -> readonly-канал устройства.
// Топик содержит слэши, поэтому используется when() c обратным вызовом,
// а не строковая форма whenChanged ("device/control" нотация тут неприменима).
// ---------------------------------------------------------------------------
defineRule("climate_ui_recv_command", {
    when: function (match) {
        return match("/wb/climate/fb/CompressorCommand");
    },
    then: function (topic, message) {
        var v = NaN;
        try {
            v = Number(String(message));
        } catch (e) {
            return;
        }
        if (isNaN(v)) return;
        dev["climate_ui/CompressorCommand"] = v ? 1 : 0;
    }
});

// ---------------------------------------------------------------------------
// Отображение фактического состояния реле компрессора (WB-WRM2 K1)
// MQTT-топик контроллера: wb-mrwm2_134/K1 -> в wb-rules: "wb-mrwm2_134/K1"
// ---------------------------------------------------------------------------
defineRule("climate_ui_compressor_actual", {
    whenChanged: "wb-mrwm2_134/K1",
    then: function (newValue) {
        dev["climate_ui/CompressorActual"] = newValue ? 1 : 0;
    }
});

// ---------------------------------------------------------------------------
// Отображение температур с модулей RS-485
// MQTT-топики контроллера содержат пробелы ("wb-mai6_28/IN 1 N Temperature"),
// в wb-rules это device "wb-mai6_28", channel "IN 1 N Temperature".
// Подписка whenChanged по составному имени работает и с пробелами в канале.
// ---------------------------------------------------------------------------
var TEMP_CHANNELS = [
    // [device/channel в нотации wb-rules, имя канала climate_ui]
    ["wb-mai6_28/IN 1 N Temperature", "TempBottom"],    // низ камеры
    ["wb-mai6_28/IN 2 P Temperature", "TempTop"],       // верх камеры
    ["wb-mai6_28/IN 1 P Temperature", "TempPortable"],  // переносной термометр
    ["wb-mai6_28/Internal Temperature", "TempExternal"] // снаружи камеры
];

TEMP_CHANNELS.forEach(function (pair, i) {
    defineRule("climate_ui_temp_" + i, {
        whenChanged: pair[0],
        then: function (newValue) {
            var v = Number(newValue);
            if (newValue === null || newValue === undefined || isNaN(v)) return;
            dev["climate_ui/" + pair[1]] = Math.round(v * 100) / 100;
        }
    });
});

// ---------------------------------------------------------------------------
// Стартовая публикация текущих значений параметров (на случай, если скрипт
// термостата перезапустился позже и не получил retained-значения).
// runAtStartup выполняется при каждой загрузке/перезапуске правил.
// ---------------------------------------------------------------------------
defineRule("climate_ui_initial_publish", {
    runAtStartup: true,
    then: function () {
        ["Mode", "Manual", "TargetTemp", "Hysteresis"].forEach(function (name) {
            var v = dev["climate_ui/" + name];
            if (v !== null && v !== undefined) {
                publish("wb/climate/set/" + name, String(v),
                        { qos: 0, retain: true });
            }
        });
    }
});

log.info("climate_ui: правила загружены");
