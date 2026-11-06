#!/usr/bin/env python3
"""ydesk input helper for macOS: reads commands on stdin, posts CGEvents."""

import base64
import ctypes
import sys

try:
    cg = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
except OSError:
    cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')


class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]


class CGSize(ctypes.Structure):
    _fields_ = [('width', ctypes.c_double), ('height', ctypes.c_double)]


class CGRect(ctypes.Structure):
    _fields_ = [('origin', CGPoint), ('size', CGSize)]


cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
cg.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
cg.CGEventCreateScrollWheelEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
                                            ctypes.c_int32, ctypes.c_int32]
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
cg.CGEventKeyboardSetUnicodeString.restype = ctypes.c_int32
cg.CGEventKeyboardSetUnicodeString.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
cg.CGDisplayBounds.restype = CGRect
cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
cg.CGMainDisplayID.restype = ctypes.c_uint32

kCGHIDEventTap = 0
LEFT_DOWN, LEFT_UP, RIGHT_DOWN, RIGHT_UP = 1, 2, 3, 4
MOVED, LEFT_DRAG, RIGHT_DRAG = 5, 6, 7
OTHER_DOWN, OTHER_UP, OTHER_DRAG = 25, 26, 27

# Modifier masks for CGEventSetFlags.
FLAG_SHIFT, FLAG_CONTROL, FLAG_OPTION, FLAG_COMMAND = 1 << 17, 1 << 18, 1 << 19, 1 << 20
MODIFIER_CODES = {
    56: FLAG_SHIFT, 60: FLAG_SHIFT,
    59: FLAG_CONTROL, 62: FLAG_CONTROL,
    58: FLAG_OPTION, 61: FLAG_OPTION,
    55: FLAG_COMMAND, 54: FLAG_COMMAND,
}

buttons_down = set()
active_flags = 0


def screen_size():
    rect = cg.CGDisplayBounds(cg.CGMainDisplayID())
    return max(1.0, rect.size.width), max(1.0, rect.size.height)


def point(nx, ny):
    width, height = screen_size()
    return CGPoint(max(0.0, min(1.0, nx)) * (width - 1.0), max(0.0, min(1.0, ny)) * (height - 1.0))


def post(event):
    if not event:
        return
    if active_flags:
        cg.CGEventSetFlags(event, active_flags)
    cg.CGEventPost(kCGHIDEventTap, event)
    try:
        cg.CFRelease(ctypes.c_void_p(event))
    except Exception:
        pass


def move(nx, ny):
    pos = point(nx, ny)
    if 1 in buttons_down:
        kind = LEFT_DRAG
    elif 2 in buttons_down:
        kind = RIGHT_DRAG
    elif 3 in buttons_down:
        kind = OTHER_DRAG
    else:
        kind = MOVED
    post(cg.CGEventCreateMouseEvent(None, kind, pos, 0))


def button(code, down):
    pos = point(*last_point)
    if code == 1:
        kind, btn = (LEFT_DOWN, 0) if down else (LEFT_UP, 0)
    elif code == 2:
        kind, btn = (RIGHT_DOWN, 1) if down else (RIGHT_UP, 1)
    else:
        kind, btn = (OTHER_DOWN, 2) if down else (OTHER_UP, 2)
    if down:
        buttons_down.add(code)
    else:
        buttons_down.discard(code)
    post(cg.CGEventCreateMouseEvent(None, kind, pos, btn))


def wheel(vertical, horizontal=0):
    if vertical:
        post(cg.CGEventCreateScrollWheelEvent(None, 1, 2, int(vertical), 0))
    if horizontal:
        post(cg.CGEventCreateScrollWheelEvent(None, 1, 2, 0, int(horizontal)))


def key(code, down):
    global active_flags
    event = cg.CGEventCreateKeyboardEvent(None, code, down)
    previous = active_flags
    mask = MODIFIER_CODES.get(code)
    if mask:
        active_flags = (active_flags | mask) if down else (active_flags & ~mask)
    if previous:
        cg.CGEventSetFlags(event, previous)
    cg.CGEventPost(kCGHIDEventTap, event)
    try:
        cg.CFRelease(ctypes.c_void_p(event))
    except Exception:
        pass


def text(value):
    data = value.encode('utf-16-le')
    units = len(data) // 2
    buf = ctypes.create_string_buffer(data, len(data))
    event = cg.CGEventCreateKeyboardEvent(None, 0, True)
    cg.CGEventKeyboardSetUnicodeString(event, units, buf)
    cg.CGEventPost(kCGHIDEventTap, event)
    up = cg.CGEventCreateKeyboardEvent(None, 0, False)
    cg.CGEventKeyboardSetUnicodeString(up, units, buf)
    cg.CGEventPost(kCGHIDEventTap, up)


last_point = (0.5, 0.5)


def main():
    global last_point
    sys.stdout.write('READY\n')
    sys.stdout.flush()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        parts = line.split(' ')
        cmd = parts[0]
        try:
            if cmd == 'm':
                last_point = (float(parts[1]), float(parts[2]))
                move(*last_point)
            elif cmd == 'md':
                button(int(parts[1]), True)
            elif cmd == 'mu':
                button(int(parts[1]), False)
            elif cmd == 'w':
                wheel(int(float(parts[1])), int(float(parts[2])) if len(parts) > 2 else 0)
            elif cmd == 'kd':
                key(int(parts[1]), True)
            elif cmd == 'ku':
                key(int(parts[1]), False)
            elif cmd == 't':
                text(base64.b64decode(parts[1]).decode('utf-8'))
            elif cmd == 'size':
                width, height = screen_size()
                sys.stdout.write('SIZE %d %d\n' % (width, height))
                sys.stdout.flush()
        except Exception as exc:  # keep the helper alive on a bad command
            sys.stdout.write('ERR %s\n' % exc)
            sys.stdout.flush()


if __name__ == '__main__':
    main()
