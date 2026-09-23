# Климатическая камера на Wiren Board 8 (JS-скрипты)

## Состав

| Файл | Назначение |
|---|---|
| `climate_ui.js` | Скрипт №1: виртуальное устройство `climate_ui` — интерфейс пользователя (Mode, Manual, TargetTemp, Hysteresis, CompressorCommand readonly, индикация температур) |
| `climate_ctrl.js` | Скрипт №2: термостат с гистерезисом, защитой компрессора и аварийным стопом; управляет реле WB-WRM2 |
| `wb_mqtt.js` | Общая библиотека: регистрация/публикация каналов виртуального устройства WB по протоколу `/devices/...` |

## Установка и запуск (на WB8)

```sh
cd /root/climate-js
npm install mqtt
node climate_ui.js   localhost 1883 &
node climate_ctrl.js localhost 1883 &
```

## Схема взаимодействия скриптов

```
                        ┌──────────────────────────────────────────────┐
                        │            Пользователь (браузер)            │
                        │      Web-конфигуратор WB / wb-rules / UI     │
                        └───────────────┬──────────────────────────────┘
     set-команды                        │
  /devices/climate_ui/controls/         ▼
      {Mode|Manual|TargetTemp|Hysteresis}/set
                 ┌────────────────────────────────┐
                 │        climate_ui.js           │
                 │  вирт. устройство "climate_ui" │
                 │  Mode(switch RW) 0=OFF 1=AUTO  │
                 │  Manual(switch RW) 0=OFF 1=ON  │
                 │  TargetTemp(value RW), °C      │
                 │  Hysteresis(value RW), K       │
                 │  CompressorCommand(switch RO)◄─┼── выход термостата
                 │  TempBottom/Top/Portable/Ext(RO)│
                 └───────┬────────────────▲───────┘
    wb/climate/set/#     │ retained       │  wb/climate/fb/CompressorCommand
    {Mode|Manual|        ▼                │  (обратная связь контроллера)
     TargetTemp|Hysteresis}               │
                 ┌────────────────────────┴───────┐
                 │        climate_ctrl.js         │
                 │  термостат (гистерезис)        │
                 │  + защита компрессора          │
                 │    MIN_ON/MIN_OFF = 180 c      │
                 │  + авария при пропадании       │
                 │    данных > 60 c → Command=0   │
                 └───────┬────────────────▲───────┘
    команда реле         │                │ подписка (сверка факта)
    wb-mrwm2_134/K1      ▼                │
             ═══════════ RS-485 ══════════╪═══════════════════════
                 ┌───────────────┐  ┌─────┴──────────┐
                 │   WB-WRM2     │  │    WB-MAI6     │
                 │  K1→компрессор│  │ IN1N T низ     │──► "wb-mai6_28/IN 1 N Temperature"
                 │  (встроенный  │  │ IN2P T верх    │──► "wb-mai6_28/IN 2 P Temperature"
                 │   датчик T    │  │ IN1P переносной│──► "wb-mai6_28/IN 1 P Temperature"
                 │   внешн.)     │  │ Internal T нар.│──► "wb-mai6_28/Internal Temperature"
                 └───────────────┘  └────────────────┘
                     (топик "wb-mrwm2_134/K1")   значения публикуются
                                                 wb-mqtt-serial в брокер WB8
```

### Потоки данных

1. **Пользователь → climate_ui**: запись в каналы виртуального устройства
   `/devices/climate_ui/controls/{Mode,Manual,TargetTemp,Hysteresis}/set`.
2. **climate_ui → climate_ctrl**: ретрансляция настроек в служебную шину
   `wb/climate/set/{Mode,Manual,TargetTemp,Hysteresis}` (retain — контроллер
   получает актуальные уставки сразу после перезапуска).
3. **RS485 → брокер**: `wb-mqtt-serial` публикует показания датчиков
   (`wb-mai6_28/...`, `wb-mrwm2_134/K1`) — их слушают оба скрипта:
   UI для индикации, контроллер для расчёта.
4. **climate_ctrl → железо**: при смене решения термостат публикует команду
   `wb-mrwm2_134/K1` (=1 включить / =0 выключить компрессор).
5. **climate_ctrl → climate_ui**: команда дублируется в
   `wb/climate/fb/CompressorCommand`, откуда попадает в readonly-канал
   `/devices/climate_ui/controls/CompressorCommand`.

### Алгоритм термостата (climate_ctrl)

| Условие | Действие |
|---|---|
| `Mode = 0 (OFF)` | CompressorCommand = 0 |
| `Manual = 1` (при AUTO) | CompressorCommand = 1 (ручной пуск, приоритет) |
| `AUTO`: T ≥ Target + Hysteresis | CompressorCommand = 1 |
| `AUTO`: T ≤ Target − Hysteresis | CompressorCommand = 0 |
| между порогами | удержание предыдущего состояния |
| нет данных T > 60 c | авария, CompressorCommand = 0 |

T = среднее(низ, верх); если оба штатных датчика недоступны — переносной термометр.
Защита компрессора: не чаще одного переключения в 180 c (MIN_ON/MIN_OFF).
