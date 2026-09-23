// -*- coding: utf-8 -*-
/**
 * wb_mqtt.js — общая библиотека для скриптов климатической камеры (Wiren Board 8).
 *
 * Реализует протокол виртуальных устройств Wiren Board поверх MQTT:
 *   * регистрация устройства и каналов через JSON в devices/<name>/meta,
 *   * публикация значений в devices/<name>/controls/<Ctrl>/on (retained),
 *   * подписка на команды devices/<name>/controls/<Ctrl>/set.
 *
 * Зависимость: npm i mqtt   (mqtt v5, API совместим с v4 через mqtt.connect)
 */

const mqtt = require("mqtt");

class WBVirtualDevice {
  /**
   * @param {object} client     подключённый mqtt-клиент
   * @param {string} name       имя устройства (топик devices/<name>)
   * @param {string} title      человекочитаемое название
   * @param {Array}  controls   [{id,type,order,label,min,max,precision,units,writeable,readonly}]
   * @param {function(string, number|string):void} onSet  callback(controlId, value)
   */
  constructor(client, name, title, controls, onSet) {
    this.client = client;
    this.name = name;
    this.title = title;
    this.controls = {};
    controls.forEach((c, i) => {
      c.order = c.order !== undefined ? c.order : i + 1;
      this.controls[c.id] = c;
    });
    this.onSet = onSet || function () {};

    // приём команд пользователя (WB UI / rules) для всех каналов устройства
    client.on("message", (topic, payload) => {
      const m = topic.match(
        new RegExp("\^/?devices/" + name + "/controls/([^/]+)/set$")
      );
      if (!m) return;
      const cid = m[1];
      if (!(cid in this.controls)) return;
      const raw = String(payload).trim();
      let value;
      try {
        value = this._parse(cid, raw);
      } catch (e) {
        return; // нечисловое значение для числового канала — игнорируем
      }
      this.onSet(cid, value);
    });
  }

  _parse(cid, raw) {
    const t = this.controls[cid].type;
    const n = Number(raw);
    if (t === "switch") {
      if (Number.isNaN(n)) throw new Error("bad switch value");
      return n ? 1 : 0;
    }
    if (t === "value" || t === "range") {
      if (Number.isNaN(n)) throw new Error("bad numeric value");
      return n;
    }
    return raw; // text
  }

  /** Публикует описание устройства и каналов в devices/<name>/meta (retained). */
  publishMeta() {
    const meta = {
      type: "vb",
      name: this.name,
      title: this.title,
      description: this.title,
      controls: {},
    };
    for (const cid in this.controls) {
      const c = this.controls[cid];
      const ctrl = {
        type: c.type,
        order: c.order,
        readable: c.readable !== undefined ? c.readable : true,
        writeable:
          c.writeable !== undefined
            ? c.writeable
            : !c.readonly /* readonly-каналы не пишутся */,
      };
      if (c.label !== undefined) ctrl.label = c.label;
      if (c.min !== undefined) ctrl.min = c.min;
      if (c.max !== undefined) ctrl.max = c.max;
      if (c.precision !== undefined) ctrl.precision = c.precision;
      if (c.units !== undefined) ctrl.units = c.units;
      meta.controls[cid] = ctrl;
    }
    this.client.publish(
      "devices/" + this.name + "/meta",
      JSON.stringify(meta),
      { retain: true }
    );
  }

  /** Устанавливает значение канала (retained). */
  publishValue(controlId, value) {
    const c = this.controls[controlId];
    if (!c) return;
    let v = value;
    if (c.type === "switch") {
      v = Number(value) ? 1 : 0;
    } else if (c.type === "value") {
      v = Number(value);
      const p = c.precision !== undefined ? c.precision : 0.01;
      v = Math.round(v / p) * p;
      v = Number(v.toFixed(4));
    }
    const base = "devices/" + this.name + "/controls/" + controlId;
    this.client.publish(base + "/on", String(v), { retain: true });
  }
}

/** Создаёт mqtt-клиент (без автоподписок; connect выполняется внутри). */
function makeClient(clientId, host, port) {
  const url = "mqtt://" + (host || "localhost") + ":" + (port || 1883);
  const client = mqtt.connect(url, {
    clientId: clientId,
    clean: false, // сохраняем сессии/retained при переподключении
    keepalive: 60,
    reconnectPeriod: 2000,
  });
  client.on("error", (e) => console.error("[" + clientId + "] mqtt error:", e.message));
  return client;
}

module.exports = { WBVirtualDevice, makeClient };
