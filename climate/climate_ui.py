#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
climate_ui.py — скрипт №1 климатической камеры на Wiren Board 8.

Создаёт ВИРТУАЛЬНОЕ MQTT-устройство "climate_ui" с параметрами управления:

  Channel              Type     R/W      Описание
  -------------------  -------  -------  ------------------------------------------
  Mode                 switch   RW       0 = OFF, 1 = AUTO (режим термостата)
  Manual               switch   RW       0 = OFF, 1 = ON   (ручной пуск компрессора)
  TargetTemp           value    RW       целевая температура камеры, °C
  Hysteresis           value    RW       гистерезис вокруг TargetTemp, K
  CompressorCommand    switch   R(RO)    ВЫХОД термостата: 1 — включать компрессор
  TempBottom           value    R        текущая температура (низ), из WB-MAI6 IN1N
  TempTop              value    R        текущая температура (верх), из WB-MAI6 IN2P
  TempPortable         value    R        переносной термометр, WB-MAI6 IN1P
  TempExternal         value    R        датчик снаружи камеры, WB-MAI6 Internal

Взаимодействие со скриптом climate_ctrl идёт только через MQTT:
  * команды /devices/climate_ui/controls/{Mode,Manual,TargetTemp,Hysteresis}/set
    сохраняются и ретранслируются в служебную группу wb/climate/set/#;
  * состояние CompressorCommand публикуется readonly-каналом устройства.

Запуск:  python3 climate_ui.py [broker_host] [broker_port]
"""

import sys
import time

from wb_mqtt import WBVirtualDevice, make_client, connect

DEVICE = "climate_ui"

# ---- топики физических модулей (wiren-board conventions) ----
TOPIC_MODE = "wb-mrwm2_134/K1"                    # реле WB-WRM2 -> компрессор
T_BOTTOM = "wb-mai6_28/IN 1 N Temperature"        # термометр внутри, низ
T_TOP = "wb-mai6_28/IN 2 P Temperature"           # термометр внутри, верх
T_PORTABLE = "wb-mai6_28/IN 1 P Temperature"      # переносной термометр
T_EXT = "wb-mai6_28/Internal Temperature"         # датчик снаружи камеры

# служебная шина между двумя скриптами
SET_PREFIX = "wb/climate/set/"                     # ui -> ctrl
FB_PREFIX = "wb/climate/fb/"                       # ctrl -> ui (обратная связь)

CONTROLS = [
    dict(id="Mode", type="switch", order=1, label="Режим (0=OFF,1=AUTO)",
         writeable=True),
    dict(id="Manual", type="switch", order=2, label="Ручной режим (0=OFF,1=ON)",
         writeable=True),
    dict(id="TargetTemp", type="value", order=3, label="Целевая температура",
         min=-40, max=125, precision=0.1, units="deg C", writeable=True),
    dict(id="Hysteresis", type="value", order=4, label="Гистерезис",
         min=0.1, max=10, precision=0.1, units="deg C", writeable=True),
    dict(id="CompressorCommand", type="switch", order=5,
         label="Команда компрессору", readonly=True),
    dict(id="TempBottom", type="value", order=6, label="T внутри низ",
         precision=0.1, units="deg C", readonly=True),
    dict(id="TempTop", type="value", order=7, label="T внутри верх",
         precision=0.1, units="deg C", readonly=True),
    dict(id="TempPortable", type="value", order=8, label="T переносной",
         precision=0.1, units="deg C", readonly=True),
    dict(id="TempExternal", type="value", order=9, label="T снаружи",
         precision=0.1, units="deg C", readonly=True),
]

DEFAULTS = {"Mode": 1, "Manual": 0, "TargetTemp": 5.0, "Hysteresis": 0.5}


class ClimateUI:
    def __init__(self, client):
        self.client = client
        self.state = dict(DEFAULTS)
        self.dev = WBVirtualDevice(client, DEVICE, "Климат-камера UI",
                                   CONTROLS, on_set=self.on_set)

        # подписка на температуры физических модулей (для индикации)
        for topic in (T_BOTTOM, T_TOP, T_PORTABLE, T_EXT):
            client.message_callback_add(topic, self._on_temp)
        # подписка на фактическое состояние реле WB-WRM2 (для сверки)
        client.message_callback_add(TOPIC_MODE, self._on_relay_fb)
        # подписка на обратную связь от контроллера
        client.message_callback_add(FB_PREFIX + "+", self._on_ctrl_fb)

        client.subscribe(TOPIC_MODE)
        for topic in (T_BOTTOM, T_TOP, T_PORTABLE, T_EXT):
            client.subscribe(topic)
        client.subscribe(FB_PREFIX + "#")

    # ---------- регистрация и стартовые значения ----------
    def start(self):
        self.dev.publish_meta()
        for cid, v in DEFAULTS.items():
            self.dev.publish_value(cid, v)
            self.client.publish(SET_PREFIX + cid, str(v), retain=True)
        print("[climate_ui] устройство '%s' зарегистрировано" % DEVICE)

    # ---------- приём команд от пользователя (WB UI / rules) ----------
    def on_set(self, cid, value):
        if cid not in ("Mode", "Manual", "TargetTemp", "Hysteresis"):
            return  # readonly-каналы не принимаем
        # ограничение диапазона
        if cid == "TargetTemp":
            value = max(-40.0, min(125.0, float(value)))
        if cid == "Hysteresis":
            value = max(0.1, min(10.0, float(value)))
        self.state[cid] = value
        self.dev.publish_value(cid, value)
        # транслируем настройку контроллеру
        self.client.publish(SET_PREFIX + cid, str(value), retain=True)
        print("[climate_ui] set %s = %s" % (cid, value))

    # ---------- показания температур ----------
    def _on_temp(self, c, u, msg):
        try:
            v = float(msg.payload.decode())
        except ValueError:
            return
        mapping = {T_BOTTOM: "TempBottom", T_TOP: "TempTop",
                   T_PORTABLE: "TempPortable", T_EXT: "TempExternal"}
        cid = mapping.get(msg.topic)
        if cid:
            self.dev.publish_value(cid, v)

    # ---------- обратная связь от контроллера ----------
    def _on_ctrl_fb(self, c, u, msg):
        key = msg.topic.split("/")[-1]
        if key == "CompressorCommand":
            try:
                val = int(float(msg.payload.decode()))
            except ValueError:
                return
            self.dev.publish_value("CompressorCommand", val)

    def _on_relay_fb(self, c, u, msg):
        # логируем фактическое состояние реле WB-WRM2 (сверка с командой)
        try:
            fact = int(float(msg.payload.decode()))
        except ValueError:
            return
        print("[climate_ui] факт реле %s = %d" % (msg.topic, fact))


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "localhost"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 1883
    client = make_client("wb-climate-ui")
    connect(client, host, port)
    app = ClimateUI(client)
    app.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[climate_ui] остановка")


if __name__ == "__main__":
    main()
