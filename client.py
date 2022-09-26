from tkinter import *
from math import *
import pyautogui
import keyboard
import requests


keyboard.add_hotkey("alt + m", lambda: hotkey())
app = Tk()

m1 = (0,0)
m2 = (0,0)
mr1 = (0,0)
mr2 = (0,0)
counter = 0
counter2 = 0

def hotkey():
    pos = pyautogui.position()
    resp = requests.post('http://localhost:8080/arta/x/'+str(pos[0]))
    resp = requests.post('http://localhost:8080/arta/y/'+str(pos[1]))
    label["text"] = resp.text

def ModeChange(a):
    #print('http://localhost:8080/arta/scale/'+str(int(a)))
    resp = requests.post('http://localhost:8080/arta/mode/'+str(int(a)))
    label["text"] = resp.text

def SizeChange():
    resp = requests.post('http://localhost:8080/arta/scale/'+map_size.get())
    label["text"] = resp.text
r_var = BooleanVar()
r_var.set(0)
map_size = StringVar()
label = Label(app, text="Масштаб карты не установлен", font='Arial 50')
label.pack()
frame_top = Frame(app).pack(side=TOP)
r1 = Radiobutton(frame_top,text='Указать курсором одну клетку масштаб которой =', variable=r_var, value=0,command = lambda : ModeChange(r_var.get()))
r1.pack(side=LEFT)
l1 = Entry(frame_top, textvariable=map_size)
l1.pack(side=LEFT)
frame_bottom = Frame(app).pack(side=BOTTOM)
r2 = Radiobutton(frame_bottom,text='Указать курсором себя и цель', variable=r_var, value=1,command = lambda : ModeChange(r_var.get()))
r2.pack(side=LEFT)
btn = Button(text="Ввести дальность", command=lambda: SizeChange())
btn.pack(side=LEFT)


app.mainloop()


