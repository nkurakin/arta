# -*- coding: utf-8 -*-
"""
Общая библиотека для скриптов климатической камеры (Wiren Board 8).

Реализует протокол виртуальных устройств wb-mqtt-serial / Wiren Board:
  * регистрация устройства и его каналов через JSON в /devices/<name>/meta,
  * публикация значений в /devices/<name>/controls/<Ctrl>/on,
  * подписка на команды управления /devices/<name>/controls/<Ctrl>/set,
  * поддержка "полезной нагрузки" (retained) - состояние сохраняется в брокере.

Топики MQTT (по умолчанию localhost:1883 на самом WB8):
  /devices/climate_ui/controls/Mode           -- switch 0/1 (OFF/AUTO)
  /devices/climate_ui/controls/Manual         -- switch 0/1 (OFF/ON)
  /devices/climate_ui/controls/TargetTemp     -- number, degC
  /devices/climate_ui/controls/Hysteresis     -- number, K
  /devices/climate_ui/controls/CompressorCommand -- switch readonly (выход термостата)
"""

import json
import threading

import paho.mqtt.client as mqtt


class WBVirtualDevice:
    """Виртуальное устройство Wiren Board поверх MQTT (paho-mqtt)."""

    def __init__(self, client, name, title, controls, on_set=None):
        """
        :param client:  подключённый mqtt.Client
        :param name:    имя устройства (топик /devices/<name>)
        :param title:   человекочитаемое название
        :param controls: список словарей-описаний каналов:
                        {"id": "Mode", "type": "switch", "order": 1,
                         "label": "Режим", "min": ..., "max": ..., "units": ...}
        :param on_set:  callable(control_id, value) - вызывается при получении
                        команды из /devices/<name>/controls/<id>/set
        """
        self.client = client
        self.name = name
        self.title = title
        self.controls = {c["id"]: c for c in controls}
        self.order = {c["id"]: c.get("order", i)
                      for i, c in enumerate(controls)}
        self.on_set = on_set or (lambda cid, v: None)
        self._lock = threading.Lock()

        # Подписка на команды управления всеми каналами устройства
        client.message_callback_add(
            "/devices/%s/controls/+/set" % name, self._handle_set)

    # ---------- регистрация в meta ----------
    def publish_meta(self):
        """Публикует описание устройства и каналов в /devices/<name>/meta."""
        meta = {
            "type": "vb",                       # virtual button/device
            "name": self.name,
            "title": self.title,
            "description": self.title,
            "controls": {},
        }
        for cid, c in self.controls.items():
            ctrl = {
                "type": c["type"],
                "order": self.order[cid],
                "readable": c.get("readable", True),
                "writeable": c.get("writeable", not c.get("readonly", False)),
            }
            if "label" in c:
                ctrl["label"] = c["label"]
            if "min" in c:
                ctrl["min"] = c["min"]
            if "max" in c:
                ctrl["max"] = c["max"]
            if "precision" in c:
                ctrl["precision"] = c["precision"]
            if "units" in c:
                ctrl["units"] = c["units"]
            meta["controls"][cid] = ctrl
        self.client.publish("/devices/%s/meta" % self.name,
                            json.dumps(meta, ensure_ascii=False), retain=True)

    # ---------- публикация значения ----------
    def publish_value(self, control_id, value):
        """Устанавливает значение канала (retained) и обновляет meta/value."""
        c = self.controls[control_id]
        v = self._coerce(c, value)
        base = "/devices/%s/controls/%s" % (self.name, control_id)
        with self._lock:
            self.client.publish(base + "/on", str(v), retain=True)
            self.client.publish(base + "/value", str(v), retain=True)
            err = 0 if not c.get("error") else 1
            self.client.publish(base + "/meta/error", str(err), retain=True)

    @staticmethod
    def _coerce(ctrl, value):
        t = ctrl["type"]
        if t in ("switch", "text", "range"):
            if t == "switch":
                return 1 if int(float(value)) else 0
            return value
        if t == "value":          # числовой датчик (number)
            f = float(value)
            p = ctrl.get("precision", 0.01)
            return round(f / p) * p
        return value

    # ---------- приём команд ----------
    def _handle_set(self, client, userdata, msg):
        # /devices/<name>/controls/<id>/set
        try:
            cid = msg.topic.split("/")[4]
        except IndexError:
            return
        if cid not in self.controls:
            return
        raw = msg.payload.decode("utf-8", "replace").strip()
        try:
            value = self._parse(cid, raw)
        except ValueError:
            return
        self.on_set(cid, value)

    def _parse(self, cid, raw):
        t = self.controls[cid]["type"]
        if t == "switch":
            return 1 if int(float(raw)) else 0
        if t in ("value", "text", "range"):
            try:
                return float(raw)
            except ValueError:
                return raw
        return raw


def make_client(client_id):
    """Создаёт и возвращает mqtt.Client с clean_session=False (для offline-буфера)."""
    c = mqtt.Client(client_id=client_id, clean_session=False, protocol=mqtt.MQTTv311)
    return c


def connect(client, host="localhost", port=1883):
    client.connect(host, port, keepalive=60)
    client.loop_start()
    return client
