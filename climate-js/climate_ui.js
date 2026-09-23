#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * climate_ui.js — скрипт №1 климатической камеры на Wiren Board 8.
 *
 * Создаёт ВИРТУАЛЬНОЕ MQTT-устройство "climate_ui" с параметрами управления:
 *
 *   Channel            type     R/W     описание
 *   -----------------  -------  -----   ---------------------------------------
 *   Mode               switch   RW      0 = OFF, 1 = AUTO (режим термостата)
 *   Manual             switch   RW      0 = OFF, 1 = ON   (ручной пуск компрессора)
 *   TargetTemp         value    RW      целевая температура камеры, °C
 *   Hysteresis         value    RW      гистерезис вокруг TargetTemp, K
 *   CompressorCommand  switch   RO      ВЫХОД термостата: 1 — включать компрессор
 *   TempBottom         value    RO      T внутри, низ   (wb-mai6_28/IN 1 N Temperature)
 *   TempTop            value    RO      T внутри, верх  (wb-mai6_28/IN 2 P Temperature)
 *   TempPortable       value    RO      переносной термометр (wb-mai6_28/IN 1 P Temperature)
 *   TempExternal       value    RO      T снаружи камеры (wb-mai6_28/Internal Temperature)
 *
 * СХЕМА ВЗАИМОДЕЙСТВИЯ (только через MQTT-брокер WB8):
 *   Пользователь (WB UI / wb-rules)
 *        | /devices/climate_ui/controls/{Mode|Manual|TargetTemp|Hysteresis}/set
 *        v
 *   climate_ui.js --(retained)-> wb/climate/set/{Mode|Manual|TargetTemp|Hysteresis}
 *        ^                                   |
 *        | wb/climate/fb/CompressorCommand   v
 *        +----------------------------- climate_ctrl.js (термостат)
 *                                            | wb-mrwm2_134/K1 -> WB-WRM2 -> компрессор
 *
 * Запуск:  node climate_ui.js [broker_host] [broker_port]
 */

"use strict";

const { WBVirtualDevice, makeClient } = require("./wb_mqtt");

const DEVICE = "climate_ui";

// ---- топики физических модулей (RS485, обслуживаются wb-mqtt-serial) ----
const RELAY_TOPIC = "wb-mrwm2_134/K1"; // WB-WRM2 K1 -> компрессор
const T_BOTTOM = "wb-mai6_28/IN 1 N Temperature"; // внутри, низ
const T_TOP = "wb-mai6_28/IN 2 P Temperature"; // внутри, верх
const T_PORTABLE = "wb-mai6_28/IN 1 P Temperature"; // переносной термометр
const T_EXT = "wb-mai6_28/Internal Temperature"; // датчик снаружи камеры

// служебная шина между двумя скриптами
const SET_PREFIX = "wb/climate/set/"; // ui -> ctrl
const FB_PREFIX = "wb/climate/fb/"; // ctrl -> ui (обратная связь)

const CONTROLS = [
  { id: "Mode", type: "switch", order: 1, label: "Режим (0=OFF,1=AUTO)", writeable: true },
  { id: "Manual", type: "switch", order: 2, label: "Ручной режим (0=OFF,1=ON)", writeable: true },
  { id: "TargetTemp", type: "value", order: 3, label: "Целевая температура",
    min: -40, max: 125, precision: 0.1, units: "deg C", writeable: true },
  { id: "Hysteresis", type: "value", order: 4, label: "Гистерезис",
    min: 0.1, max: 10, precision: 0.1, units: "deg C", writeable: true },
  { id: "CompressorCommand", type: "switch", order: 5, label: "Команда компрессору", readonly: true },
  { id: "TempBottom", type: "value", order: 6, label: "T внутри низ", precision: 0.1, units: "deg C", readonly: true },
  { id: "TempTop", type: "value", order: 7, label: "T внутри верх", precision: 0.1, units: "deg C", readonly: true },
  { id: "TempPortable", type: "value", order: 8, label: "T переносной", precision: 0.1, units: "deg C", readonly: true },
  { id: "TempExternal", type: "value", order: 9, label: "T снаружи", precision: 0.1, units: "deg C", readonly: true },
];

const DEFAULTS = { Mode: 1, Manual: 0, TargetTemp: 5.0, Hysteresis: 0.5 };

class ClimateUI {
  constructor(client) {
    this.client = client;
    this.state = Object.assign({}, DEFAULTS);
    this.dev = new WBVirtualDevice(client, DEVICE, "Климат-камера UI", CONTROLS,
      (cid, value) => this.onSet(cid, value));

    const tempMap = {};
    tempMap[T_BOTTOM] = "TempBottom";
    tempMap[T_TOP] = "TempTop";
    tempMap[T_PORTABLE] = "TempPortable";
    tempMap[T_EXT] = "TempExternal";

    client.on("message", (topic, payload) => {
      const raw = String(payload).trim();
      // 1) показания температур физических модулей -> RO-каналы индикации
      if (topic in tempMap) {
        const v = Number(raw);
        if (!Number.isNaN(v)) this.dev.publishValue(tempMap[topic], v);
        return;
      }
      // 2) фактическое состояние реле WB-WRM2 (сверка с командой термостата)
      if (topic === RELAY_TOPIC) {
        console.log("[climate_ui] факт реле %s = %s", topic, raw);
        return;
      }
      // 3) обратная связь от контроллера: команда термостата -> RO-канал
      if (topic.startsWith(FB_PREFIX)) {
        const key = topic.slice(FB_PREFIX.length);
        if (key === "CompressorCommand") {
          const v = Number(raw);
          if (!Number.isNaN(v)) this.dev.publishValue("CompressorCommand", v ? 1 : 0);
        }
      }
    });

    client.on("connect", () => {
      client.subscribe([
        RELAY_TOPIC, T_BOTTOM, T_TOP, T_PORTABLE, T_EXT,
        FB_PREFIX + "#",
      ]);
      this.start();
    });
  }

  /** регистрация устройства, публикация дефолтов и рассылка настроек контроллеру */
  start() {
    this.dev.publishMeta();
    for (const cid in DEFAULTS) {
      this.dev.publishValue(cid, DEFAULTS[cid]);
      this.client.publish(SET_PREFIX + cid, String(DEFAULTS[cid]), { retain: true });
    }
    console.log("[climate_ui] устройство '%s' зарегистрировано", DEVICE);
  }

  /** приём команд пользователя из WB UI (/devices/climate_ui/controls/<id>/set) */
  onSet(cid, value) {
    if (["Mode", "Manual", "TargetTemp", "Hysteresis"].indexOf(cid) < 0)
      return; // readonly-каналы не принимаем

    if (cid === "TargetTemp") value = Math.max(-40, Math.min(125, Number(value)));
    if (cid === "Hysteresis") value = Math.max(0.1, Math.min(10, Number(value)));

    this.state[cid] = value;
    this.dev.publishValue(cid, value);
    // транслируем настройку скрипту-термостату
    this.client.publish(SET_PREFIX + cid, String(value), { retain: true });
    console.log("[climate_ui] set %s = %s", cid, value);
  }
}

function main() {
  const host = process.argv[2] || "localhost";
  const port = Number(process.argv[3] || 1883);
  const client = makeClient("wb-climate-ui-js", host, port);
  new ClimateUI(client);
}

main();
