# Установка и запуск скриптов климатической камеры на Wiren Board 8

Пошаговая инструкция для Debian-прошивки Wiren Board (wb_debian, bullseye/trixie).
Скрипты: `climate_ui.js` (виртуальное устройство управления) и `climate_ctrl.js` (термостат).

---

## Шаг 0. Подготовка: проверка связи с камерой по RS-485

1. Подключитесь к контроллеру по SSH (логин `root`, пароль — с веб-интерфейса WB):
   ```bash
   ssh root@<IP-адрес-WB>
   ```
2. Убедитесь, что в `/etc/wb-mqtt-serial.conf` описаны оба модуля (WB-WRM2 и WB-MAI6)
   на нужном порту RS-485 (`/dev/ttyRS485-1` и т.п.), а сервис работает:
   ```bash
   systemctl status wb-mqtt-serial
   ```
3. Проверьте, что топики датчиков появляются в брокере:
   ```bash
   mosquitto_sub -v -t 'wb-mai6_28/#'    # Ctrl+C для выхода
   mosquitto_sub -v -t 'wb-mrwm2_134/#'
   ```
   Вы должны видеть значения `IN 1 N Temperature`, `IN 2 P Temperature`,
   `IN 1 P Temperature`, `Internal Temperature` и реле `K1`.
   Если топиков нет — сначала настройте опрос Serial-устройств через веб-интерфейс
   («Настройки → Опрос шине RS-485»), без этого скрипты работать не будут.

## Шаг 1. Установка Node.js

В репозитории Wiren Board есть пакет `nodejs`:

```bash
apt update
apt install -y nodejs npm
node --version    # должно быть >= 14 (рекомендуется 16+)
```

Если системный пакет слишком старый или отсутствует, установите LTS из nodesource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version && npm --version
```

## Шаг 2. Копирование файлов на контроллер

На своём компьютере (в папке `climate-js`) выполните:

```bash
scp climate_ui.js climate_ctrl.js wb_mqtt.js package.json root@<IP-адрес-WB>:/opt/climate/
```

(папку создайте заранее: `ssh root@<IP> "mkdir -p /opt/climate"`)

**Не копируйте** `node_modules/` — он будет установлен заново на контроллере
(ARM-платформа, бинарные зависимости могут отличаться).

## Шаг 3. Установка npm-зависимостей (на контроллере)

```bash
cd /opt/climate
npm install mqtt
```

Проверка:

```bash
node -e "require('mqtt'); console.log('mqtt OK')"
```

## Шаг 4. Ручной тестовый запуск

Терминал 1 — интерфейс устройства:

```bash
cd /opt/climate && node climate_ui.js
```

Терминал 2 — термостат:

```bash
cd /opt/climate && node climate_ctrl.js
```

Проверка в веб-интерфейсе Wiren Board («Устройства»): должно появиться виртуальное
устройство **climate_ui** с каналами `Mode`, `Manual`, `TargetTemp`, `Hysteresis`,
`CompressorCommand` и показаниями температур.

Быстрая MQTT-проверка прямо на контроллере:

```bash
# установить целевую температуру 5 °C, включить AUTO
mosquitto_pub -t 'devices/climate_ui/controls/TargetTemp/set' -m 5
mosquitto_pub -t 'devices/climate_ui/controls/Mode/set' -m 1
# понаблюдать за командой компрессору
mosquitto_sub -v -t 'wb-mrwm2_134/K1' -t 'devices/climate_ui/controls/CompressorCommand'
```

Остановить скрипты тестового запуска: `Ctrl+C`.

## Шаг 5. Автозапуск через systemd

Создайте юнит интерфейса:

```bash
cat > /etc/systemd/system/climate-ui.service <<'EOF'
[Unit]
Description=Climate chamber UI virtual device (WB)
After=network-online.target mosquitto.service wb-mqtt-serial.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/climate
ExecStart=/usr/bin/node /opt/climate/climate_ui.js localhost 1883
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Создайте юнит термостата (здесь же — защита компрессора, паузы 180 с по умолчанию,
можно переопределить):

```bash
cat > /etc/systemd/system/climate-ctrl.service <<'EOF'
[Unit]
Description=Climate chamber thermostat controller (WB)
After=network-online.target mosquitto.service wb-mqtt-serial.service climate-ui.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/climate
Environment=MIN_ON_SEC=180
Environment=MIN_OFF_SEC=180
ExecStart=/usr/bin/node /opt/climate/climate_ctrl.js localhost 1883
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Активация:

```bash
systemctl daemon-reload
systemctl enable --now climate-ui.service climate-ctrl.service
systemctl status climate-ui.service climate-ctrl.service
```

Путь к node можно уточнить командой `which node` и при необходимости поправить `ExecStart`.

## Шаг 6. Мониторинг и управление

```bash
journalctl -u climate-ctrl -f      # живые логи термостата
journalctl -u climate-ui  -f       # живые логи устройства
```

Управление — из веб-интерфейса WB (карточка устройства climate_ui), либо командами:

```bash
mosquitto_pub -t 'devices/climate_ui/controls/Manual/set' -m 1     # ручной пуск
mosquitto_pub -t 'devices/climate_ui/controls/Manual/set' -m 0     # ручной стоп
mosquitto_pub -t 'devices/climate_ui/controls/Hysteresis/set' -m 0.5
```

Логика приоритета: `Manual=1` жёстко включает компрессор независимо от AUTO;
при `Mode=0 (OFF)` и `Manual=0` компрессор выключен; при пропадании данных
датчиков (>60 с) — авария, команда снимается.

## Типичные проблемы

| Симптом | Причина / решение |
|---|---|
| `Error: connect ECONNREFUSED ::1:1883` | Брокер слушает только IPv4. Передайте явно хост `127.0.0.1`: `ExecStart=/usr/bin/node ... 127.0.0.1 1883` |
| Устройство climate_ui не видно в UI | Проверьте `journalctl -u climate-ui`; убедитесь, что mosquitto запущен (`systemctl status mosquitto`) |
| Температуры равны null/нет значений | Не настроен опрос RS-485 (Шаг 0); проверьте `wb-mqtt-serial` и адреса устройств (`wb-mai6_28`, `wb-mrwm2_134`) |
| Компрессор не реагирует | Тест реле напрямую: `mosquitto_pub -t 'wb-mrwm2_134/K1' -m 1` (затем `-m 0`); проверьте прошивку/питание WB-WRM2 |
| `node: not found` в systemd | Укажите абсолютный путь из `which node` |

## Обновление скриптов

```bash
scp climate_ui.js climate_ctrl.js wb_mqtt.js root@<IP>:/opt/climate/
systemctl restart climate-ui climate-ctrl
```

---

### Примечание об исправлении (актуально)

В библиотеке `wb_mqtt.js` топики виртуального устройства приведены к стандарту
Wiren Board — **без ведущего слэша**: `devices/climate_ui/...` (ранее использовалось
`/devices/...`, из-за чего контроллер не подписывался на команды `set`). Файлы в
репозитории обновлены и проверены `node --check`; при переустановке скопируйте
обновлённый `wb_mqtt.js` и перезапустите сервисы.
