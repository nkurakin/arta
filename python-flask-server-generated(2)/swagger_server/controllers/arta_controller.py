import connexion
import six
from math import *

from swagger_server import util
mode = 0
map_size = 0
m1 = [0,0]
m2 = [0,0]
mr1 = [0,0]
mr2 = [0,0]
counterx = 0
countery = 0

def map_new_mode(modeid):  # noqa: E501
    global mode, counterx, countery
    """Update an existing mode

     # noqa: E501

    :param modeid: ID of pet to return
    :type modeid: int

    :rtype: None
    """
    if modeid == 0 or modeid == 1:
        mode = modeid
        counterx = 0
        countery = 0
        if modeid == 0:
            return 'Mode  map scaling'
        else:
            return 'Mode arta'
    else:
        mode = 2
        return 'Mode Error'


def map_new_scale(scaleid):  # noqa: E501
    global map_size
    if scaleid > 0:
        map_size = scaleid
        return 'Map scale: ' + str(map_size)
    else:
        return 'Scale Error'

def map_x(x):  # noqa: E501
    global counterx, countery, m1, m2, mr1, mr2
    if mode == 0:
        if counterx == 0:
            m1[0] = x
            counterx += 1
        elif counterx == 1:
            m2[0] = x
            counterx += 1
    elif mode == 1:
        if counterx == 0:
            mr1[0] = x
            counterx += 1
        elif counterx == 1:
            mr2[0] = x
            counterx += 1
    """X point

     # noqa: E501

    :param x: ID of pet to return
    :type x: int

    :rtype: None
    """
    if counterx == 2 and countery == 2:
        if mode == 0:
            return 'Map scale measured'
        elif mode == 1:
            counterx = 0
            countery = 0
    else:        
        return ''


def map_y(y):  # noqa: E501
    global countery, counterx, m1, m2, mr1, mr2
    if mode == 0:
        if countery == 0:
            m1[1] = y
            countery += 1
        elif countery == 1:
            m2[1] = y
            countery += 1
    elif mode == 1:
        if countery == 0:
            mr1[1] = y
            countery += 1
        elif countery == 1:
            mr2[1] = y
            countery += 1
    print(m1, m2, mr1, mr2, counterx, countery)
    """Y point

     # noqa: E501

    :param y: ID of pet to return
    :type y: int

    :rtype: None
    """
    if counterx == 2 and countery == 2:
        if mode == 0:
            return 'Map scale measured'
        elif mode == 1:
            map__size = map_size/sqrt((m2[0]-m1[0])**2 + (m2[1]-m1[1])**2)
            answer = sqrt((mr2[0]-mr1[0])**2 + (mr2[1]-mr1[1])**2)*map__size
            return round(answer, 1)
    else:        
        return ''


def result():  # noqa: E501
    """Update an existing mode

     # noqa: E501


    :rtype: None
    """
    global m1, m2, mr1, mr2, map_size, mode
    if mode == 1:
        map__size = map_size/sqrt((m2[0]-m1[0])**2 + (m2[1]-m1[1])**2)
        answer = sqrt((mr2[0]-mr1[0])**2 + (mr2[1]-mr1[1])**2)*map__size
        return round(answer, 1)
    else:
        return 'Error'
