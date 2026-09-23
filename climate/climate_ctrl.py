#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
climate_ctrl.py — скрипт №2 климатической камеры на Wiren Board 8.
Термостат с гистерезисом + защита компрессора (мин. время простоя/работы).

ВХОДЫ (MQTT-топики):
  wb/climate/set/Mode           из climate_ui   0=OFF, 1=AUTO
  wb/climate/set/Manual         из climate_ui   0=OFF, 1=ON (ручной пуск)
  wb/climate/set/TargetTemp     из climate_ui   °C
  wb/climate/set/Hysteresis     из climate_ui   K
  "wb-mai6_28/IN 1 N Temperature"  температура внутри камеры, НИЗ (RS485)
  "wb-mai6_28/IN 2 P Temperature"  температура внутри камеры, ВЕРХ (RS485)
  "wb-mai6_28/IN 1 P Temperature"  переносной термометр внутри камеры
  "wb-mai6_28/Internal Temperature" датчик снаружи камеры
  "wb-mrwm2_134/K1"                 фактическое состояние реле WB-WRM2

ВЫХОДЫ:
  wb/climate/fb/CompressorCommand  команда термостата (для readonly-канала UI)
  /devices/climate_ctrl/controls/* виртуальное устройство диагностики
  (управление самим реле wb-mrwm2_134/K1 выполняет wb-rules или CLI
   `wb-mqtt-conf`/`mosquitto_pub ... -t wb-mrwm2_134/K1/on -m 1`; здесь мы
   публикуем команду в тот же топик для совместимости с wb-mqtt-serial.)

ЛОГИКА УПРАВЛЕНИЯ:
  Mode=0 (OFF)               -> CompressorCommand = 0, реле выключено.
  Manual=1 (при Mode=1 AUTO) -> приоритет ручного режима: Command = Manual.
  AUTO без Manual:
      T_meas = среднее(низ, верх)        — усреднение двух штатных датчиков;
      если T_meas недоступна — переносной термометр;
      включение:  T_meas > TargetTemp + Hysteresis  -> Command = 1
      выключение: T_meas < TargetTemp - Hysteresis  -> Command = 0
      между порогами — удержание предыдущего состояния.
  Защита компрессора: не менее MIN_OFF/MIN_ON секунд между переключениями.
  Авария: нет данных температур дольше STALE_TIMEOUT -> Command = 0.

Запуск:  python3 climate_ctrl.py [broker_host] [broker_port]
"""

import sys
import time

from wb_mqtt import WBVirtualDevice, make_client, connect

DEVICE = "climate_ctrl"

T_BOTTOM = "wb-mai6_28/IN 1 N Temperature"
T_TOP = "wb-mai6_28/IN 2 P Temperature"
T_PORTABLE = "wb-mai6_28/IN 1 P Temperature"
T_EXT = "wb-mai6_28/Internal Temperature"
RELAY_TOPIC = "wb-mrwm2_134/K1"          # выход WB-WRM2 -> компрессор

SET_PREFIX = "wb/climate/set/"
FB_PREFIX = "wb/climate/fb/"

MIN_ON_SEC = 180        # минимальное время работы компрессора, с
MIN_OFF_SEC = 180       # минимальное время простоя компрессора, с
STALE_TIMEOUT = 60      # нет данных N сек -> авария, стоп
POLL_PERIOD = 5         # период цикла регулирования, с

CONTROLS = [
    dict(id="Mode", type="switch", order=1, label="Режим (копия)", readonly=True),
    dict(id="Manual", type="switch", order=2, label="Ручной (копия)", readonly=True),
    dict(id="TargetTemp", type="value", order=3, label="Уставка", precision=0.1,
         units="deg C", readonly=True),
    dict(id="Hysteresis", type="value", order=4, label="Гистерезис", precision=0.1,
         units="deg C", readonly=True),
    dict(id="TempMeasured", type="value", order=5, label="T расчётная",
         precision=0.1, units="deg C", readonly=True),
    dict(id="CompressorCommand", type="switch", order=6,
         label="Команда компрессору", readonly=True),
    dict(id="Fault", type="switch", order=7, label="Авария (нет данных)",
         readonly=True),
]


class Thermostat:
    def __init__(self, client):
        self.client = client
        self.dev = WBVirtualDevice(client, DEVICE, "Климат-камера термостат",
                                   CONTROLS)
        # настройки (получаем от climate_ui)
        self.mode = 1
        self.manual = 0
        self.target = 5.0
        self.hyst = 0.5
        # измерения
        self.t_bottom = None
        self.t_top = None
        self.t_portable = None
        self.t_ext = None
        self.last_rx = 0.0
        # состояние термостата
        self.command = 0
        self.fault = 0
        self.last_change_ts = time.time()

        for topic in (T_BOTTOM, T_TOP, T_PORTABLE, T_EXT):
            client.message_callback_add(topic, self._on_temp)
            client.subscribe(topic)
        client.message_callback_add(SET_PREFIX + "+", self._on_set)
        client.subscribe(SET_PREFIX + "#")
        client.subscribe(RELAY_TOPIC)

    def start(self):
        self.dev.publish_meta()
        print("[climate_ctrl] термостат запущен")

    # ---------- приём настроек от climate_ui ----------
    def _on_set(self, c, u, msg):
        key = msg.topic[len(SET_PREFIX):]
        try:
            v = float(msg.payload.decode())
        except ValueError:
            return
        if key == "Mode":
            self.mode = int(v)
        elif key == "Manual":
            self.manual = int(v)
        elif key == "TargetTemp":
            self.target = v
        elif key == "Hysteresis":
            self.hyst = max(0.1, v)
        else:
            return
        print("[climate_ctrl] <- %s = %s" % (key, v))

    # ---------- приём температур ----------
    def _on_temp(self, c, u, msg):
        try:
            v = float(msg.payload.decode())
        except ValueError:
            return
        if msg.topic == T_BOTTOM:
            self.t_bottom = v
        elif msg.topic == T_TOP:
            self.t_top = v
        elif msg.topic == T_PORTABLE:
            self.t_portable = v
        elif msg.topic == T_EXT:
            self.t_ext = v
        self.last_rx = time.time()

    # ---------- вычисление измеренной температуры ----------
    def measured(self):
        vals = [t for t in (self.t_bottom, self.t_top) if t is not None]
        if len(vals) == 2:
            return sum(vals) / 2.0
        if len(vals) == 1:
            return vals[0]
        if self.t_portable is not None:
            return self.t_portable
        return None

    # ---------- главный цикл ----------
    def loop(self):
        while True:
            now = time.time()
            stale = (now - self.last_rx) > STALE_TIMEOUT
            self.fault = 1 if stale else 0
            t_meas = None if stale else self.measured()

            new_cmd = self.command
            reason = ""
            if self.mode == 0 or stale:
                new_cmd, reason = 0, "OFF/авария"
            elif self.manual == 1:
                new_cmd, reason = self.manual, "ручной режим"
            elif t_meas is not None:
                hi = self.target + self.hyst
                lo = self.target - self.hyst
                if self.command == 0 and t_meas > hi:
                    new_cmd, reason = 1, "T=%.2f > %.2f" % (t_meas, hi)
                elif self.command == 1 and t_meas < lo:
                    new_cmd, reason = 0, "T=%.2f < %.2f" % (t_meas, lo)

            # защита компрессора: минимальные пауза/работа
            if new_cmd != self.command:
                dt = now - self.last_change_ts
                need = MIN_ON_SEC if self.command == 1 else MIN_OFF_SEC
                if dt < need:
                    reason = "задержка защиты (%.0f/%.0f c)" % (dt, need)
                    new_cmd = self.command

            if new_cmd != self.command:
                self.command = new_cmd
                self.last_change_ts = now
                self.apply_relay(new_cmd)
                print("[climate_ctrl] Command=%d (%s)" % (new_cmd, reason))

            self.publish_state(t_meas)
            time.sleep(POLL_PERIOD)

    def apply_relay(self, value):
        # команда реле WB-WRM2 (wb-mqtt-serial принимает /on и прямой топик)
        payload = str(int(value))
        self.client.publish(RELAY_TOPIC, payload, retain=True)
        self.client.publish(RELAY_TOPIC + "/on", payload, retain=False)
        # обратная связь в UI (readonly-канал CompressorCommand)
        self.client.publish(FB_PREFIX + "CompressorCommand", payload,
                            retain=True)

    def publish_state(self, t_meas):
        self.dev.publish_value("Mode", self.mode)
        self.dev.publish_value("Manual", self.manual)
        self.dev.publish_value("TargetTemp", self.target)
        self.dev.publish_value("Hysteresis", self.hyst)
        if t_meas is not None:
            self.dev.publish_value("TempMeasured", t_meas)
        self.dev.publish_value("CompressorCommand", self.command)
        self.dev.publish_value("Fault", self.fault)


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "localhost"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 1883
    client = make_client("wb-climate-ctrl")
    connect(client, host, port)
    app = Thermostat(client)
    app.start()
    try:
        app.loop()
    except KeyboardInterrupt:
        print("[climate_ctrl] остановка")


if __name__ == "__main__":
    main()
