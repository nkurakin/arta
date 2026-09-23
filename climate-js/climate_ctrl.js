#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * climate_ctrl.js — скрипт №2 климатической камеры на Wiren Board 8.
 * Термостат с гистерезисом + защита компрессора (мин. время работы/простоя).
 *
 * ВХОДЫ (MQTT-топики):
 *   wb/climate/set/Mode              из climate_ui   0=OFF, 1=AUTO
 *   wb/climate/set/Manual            из climate_ui   0=OFF, 1=ON (ручной пуск)
 *   wb/climate/set/TargetTemp        из climate_ui   °C
 *   wb/climate/set/Hysteresis        из climate_ui   K
 *   "wb-mai6_28/IN 1 N Temperature"     T внутри камеры, НИЗ   (RS485)
 *   "wb-mai6_28/IN 2 P Temperature"     T внутри камеры, ВЕРХ  (RS485)
 *   "wb-mai6_28/IN 1 P Temperature"     переносной термометр внутри камеры
 *   "wb-mai6_28/Internal Temperature"   датчик температуры снаружи камеры
 *   "wb-mrwm2_134/K1"                   фактическое состояние реле WB-WRM2
 *
 * ВЫХОДЫ:
 *   wb-mrwm2_134/K1                    команда реле WB-WRM2 -> компрессор
 *   wb/climate/fb/CompressorCommand    команда термостата (в readonly-канал UI)
 *   /devices/climate_ctrl/controls/*   виртуальное устройство диагностики
 *
 * ЛОГИКА УПРАВЛЕНИЯ:
 *   Mode=0 (OFF)                -> CompressorCommand = 0, реле выключено.
 *   Manual=1 (при Mode=1 AUTO)  -> приоритет ручного режима: Command = Manual.
 *   AUTO без Manual:
 *       T_meas = среднее(низ, верх); если недоступно — переносной термометр;
 *       включение:  T_meas > TargetTemp + Hysteresis  -> Command = 1
 *       выключение: T_meas < TargetTemp - Hysteresis  -> Command = 0
 *       между порогами — удержание предыдущего состояния.
 *   Защита компрессора: не менее MIN_OFF/MIN_ON секунд между переключениями.
 *   Авария: нет данных температур дольше STALE_TIMEOUT -> Command = 0.
 *
 * Запуск:  node climate_ctrl.js [broker_host] [broker_port]
 */

"use strict";

const { WBVirtualDevice, makeClient } = require("./wb_mqtt");

const DEVICE = "climate_ctrl";

const T_BOTTOM = "wb-mai6_28/IN 1 N Temperature";
const T_TOP = "wb-mai6_28/IN 2 P Temperature";
const T_PORTABLE = "wb-mai6_28/IN 1 P Temperature";
const T_EXT = "wb-mai6_28/Internal Temperature";
const RELAY_TOPIC = "wb-mrwm2_134/K1"; // выход WB-WRM2 -> компрессор

const SET_PREFIX = "wb/climate/set/";
const FB_PREFIX = "wb/climate/fb/";

const MIN_ON_SEC = Number(process.env.MIN_ON_SEC || 180);   // минимальное время работы компрессора, с
const MIN_OFF_SEC = Number(process.env.MIN_OFF_SEC || 180);  // минимальное время простоя компрессора, с
const STALE_TIMEOUT = 60; // нет данных N сек -> авария, стоп
const POLL_PERIOD_MS = 5000; // период цикла регулирования, мс

const CONTROLS = [
  { id: "Mode", type: "switch", order: 1, label: "Режим (копия)", readonly: true },
  { id: "Manual", type: "switch", order: 2, label: "Ручной (копия)", readonly: true },
  { id: "TargetTemp", type: "value", order: 3, label: "Уставка", precision: 0.1, units: "deg C", readonly: true },
  { id: "Hysteresis", type: "value", order: 4, label: "Гистерезис", precision: 0.1, units: "deg C", readonly: true },
  { id: "TempMeasured", type: "value", order: 5, label: "T расчётная", precision: 0.1, units: "deg C", readonly: true },
  { id: "CompressorCommand", type: "switch", order: 6, label: "Команда компрессору", readonly: true },
  { id: "Fault", type: "switch", order: 7, label: "Авария (нет данных)", readonly: true },
];

class Thermostat {
  constructor(client) {
    this.client = client;
    this.dev = new WBVirtualDevice(client, DEVICE, "Климат-камера термостат", CONTROLS);

    // настройки (получаем от climate_ui через wb/climate/set/#)
    this.mode = 1;
    this.manual = 0;
    this.target = 5.0;
    this.hyst = 0.5;
    // измерения
    this.tBottom = null;
    this.tTop = null;
    this.tPortable = null;
    this.tExt = null;
    this.lastRx = 0;
    // состояние термостата
    this.command = 0;
    this.fault = 0;
    this.lastChangeTs = Date.now() / 1000;

    client.on("message", (topic, payload) => {
      const raw = String(payload).trim();
      const v = Number(raw);
      if (Number.isNaN(v)) return;

      if (topic.startsWith(SET_PREFIX)) {
        this.onSet(topic.slice(SET_PREFIX.length), v);
      } else if (topic === T_BOTTOM) {
        this.tBottom = v; this.lastRx = Date.now() / 1000;
      } else if (topic === T_TOP) {
        this.tTop = v; this.lastRx = Date.now() / 1000;
      } else if (topic === T_PORTABLE) {
        this.tPortable = v; this.lastRx = Date.now() / 1000;
      } else if (topic === T_EXT) {
        this.tExt = v; this.lastRx = Date.now() / 1000;
      } else if (topic === RELAY_TOPIC) {
        // фактическое состояние реле — для сверки в логах
        console.log("[climate_ctrl] факт реле = %s", raw);
      }
    });

    client.on("connect", () => {
      client.subscribe([
        T_BOTTOM, T_TOP, T_PORTABLE, T_EXT, RELAY_TOPIC,
        SET_PREFIX + "#",
      ]);
      this.start();
    });
  }

  start() {
    this.dev.publishMeta();
    if (!this.timer) this.timer = setInterval(() => this.loop(), POLL_PERIOD_MS);
    console.log("[climate_ctrl] термостат запущен");
  }

  /** приём настроек от climate_ui */
  onSet(key, v) {
    switch (key) {
      case "Mode": this.mode = v ? 1 : 0; break;
      case "Manual": this.manual = v ? 1 : 0; break;
      case "TargetTemp": this.target = v; break;
      case "Hysteresis": this.hyst = Math.max(0.1, v); break;
      default: return;
    }
    console.log("[climate_ctrl] <- %s = %s", key, v);
  }

  /** расчёт измеренной температуры: среднее(низ, верх), иначе переносной */
  measured() {
    const vals = [this.tBottom, this.tTop].filter((t) => t !== null);
    if (vals.length === 2) return (vals[0] + vals[1]) / 2;
    if (vals.length === 1) return vals[0];
    if (this.tPortable !== null) return this.tPortable;
    return null;
  }

  /** главный цикл регулирования */
  loop() {
    const now = Date.now() / 1000;
    const stale = this.lastRx === 0 || now - this.lastRx > STALE_TIMEOUT;
    this.fault = stale ? 1 : 0;
    const tMeas = stale ? null : this.measured();

    let newCmd = this.command;
    let reason = "";
    if (this.mode === 0 || stale) {
      newCmd = 0; reason = "OFF/авария";
    } else if (this.manual === 1) {
      newCmd = this.manual; reason = "ручной режим";
    } else if (tMeas !== null) {
      const hi = this.target + this.hyst;
      const lo = this.target - this.hyst;
      if (this.command === 0 && tMeas > hi) {
        newCmd = 1; reason = "T=" + tMeas.toFixed(2) + " > " + hi.toFixed(2);
      } else if (this.command === 1 && tMeas < lo) {
        newCmd = 0; reason = "T=" + tMeas.toFixed(2) + " < " + lo.toFixed(2);
      }
    }

    // защита компрессора: минимальные пауза/работа
    if (newCmd !== this.command) {
      const dt = now - this.lastChangeTs;
      const need = this.command === 1 ? MIN_ON_SEC : MIN_OFF_SEC;
      if (dt < need) {
        reason = "задержка защиты (" + Math.round(dt) + "/" + need + " c)";
        newCmd = this.command;
      }
    }

    if (newCmd !== this.command) {
      this.command = newCmd;
      this.lastChangeTs = now;
      this.applyRelay(newCmd);
      console.log("[climate_ctrl] Command=%d (%s)", newCmd, reason);
    }

    this.publishState(tMeas);
  }

  applyRelay(value) {
    const payload = String(value ? 1 : 0);
    // команда реле WB-WRM2 (wb-mqtt-serial принимает прямой топик и /on)
    this.client.publish(RELAY_TOPIC, payload, { retain: true });
    this.client.publish(RELAY_TOPIC + "/on", payload, { retain: false });
    // обратная связь в UI (readonly-канал CompressorCommand)
    this.client.publish(FB_PREFIX + "CompressorCommand", payload, { retain: true });
  }

  publishState(tMeas) {
    this.dev.publishValue("Mode", this.mode);
    this.dev.publishValue("Manual", this.manual);
    this.dev.publishValue("TargetTemp", this.target);
    this.dev.publishValue("Hysteresis", this.hyst);
    if (tMeas !== null) this.dev.publishValue("TempMeasured", tMeas);
    this.dev.publishValue("CompressorCommand", this.command);
    this.dev.publishValue("Fault", this.fault);
  }
}

function main() {
  const host = process.argv[2] || "localhost";
  const port = Number(process.argv[3] || 1883);
  const client = makeClient("wb-climate-ctrl-js", host, port);
  new Thermostat(client);
}

main();
