#!/usr/bin/env python3
"""A minimal org.freedesktop.Notifications server for notify-check.ts (WP5, Linux).

It owns the session bus name, answers Notify with a server-assigned id (the same id when
`replaces_id` is set, as a real server does), and appends one JSON line per call to --log.
notify-check.ts drives it through --control, a file it appends commands to:

    invoke <id> <action>     emit ActionInvoked(id, action)
    close <id> <reason>      emit NotificationClosed(id, reason)
    quit

Needs python3-gi (PyGObject) and a session bus (`dbus-run-session`). Nothing else.
"""
import argparse
import json
import sys

from gi.repository import Gio, GLib

PATH = '/org/freedesktop/Notifications'
NAME = 'org.freedesktop.Notifications'
XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="Notify">
      <arg type="s" name="app_name" direction="in"/>
      <arg type="u" name="replaces_id" direction="in"/>
      <arg type="s" name="app_icon" direction="in"/>
      <arg type="s" name="summary" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="as" name="actions" direction="in"/>
      <arg type="a{sv}" name="hints" direction="in"/>
      <arg type="i" name="expire_timeout" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" name="id" direction="in"/></method>
    <method name="GetServerInformation">
      <arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/>
    </method>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
  </interface>
</node>
"""

parser = argparse.ArgumentParser()
parser.add_argument('--log', required=True)
parser.add_argument('--control', required=True)
args = parser.parse_args()

log = open(args.log, 'a', buffering=1)
state = {'next_id': 1, 'offset': 0, 'connection': None}


def write(event):
    log.write(json.dumps(event, default=str) + '\n')


def on_method_call(connection, sender, path, interface, method, parameters, invocation):
    if method == 'GetCapabilities':
        invocation.return_value(GLib.Variant('(as)', (['actions', 'body', 'body-markup', 'sound'],)))
    elif method == 'GetServerInformation':
        invocation.return_value(GLib.Variant('(ssss)', ('kybern-test-server', 'kybern', '1', '1.2')))
    elif method == 'CloseNotification':
        invocation.return_value(None)
    elif method == 'Notify':
        app_name, replaces_id, app_icon, summary, body, actions, hints, expire = parameters.unpack()
        if replaces_id:
            notification_id = replaces_id
        else:
            notification_id = state['next_id']
            state['next_id'] += 1
        write({'op': 'Notify', 'id': notification_id, 'app_name': app_name, 'replaces_id': replaces_id,
               'app_icon': app_icon, 'summary': summary, 'body': body, 'actions': list(actions),
               'hints': hints, 'expire_timeout': expire})
        invocation.return_value(GLib.Variant('(u)', (notification_id,)))


def poll_control():
    try:
        with open(args.control, 'r') as handle:
            handle.seek(state['offset'])
            text = handle.read()
            state['offset'] = handle.tell()
    except FileNotFoundError:
        return True
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == 'invoke':
            state['connection'].emit_signal(None, PATH, NAME, 'ActionInvoked', GLib.Variant('(us)', (int(parts[1]), parts[2])))
        elif parts[0] == 'close':
            state['connection'].emit_signal(None, PATH, NAME, 'NotificationClosed', GLib.Variant('(uu)', (int(parts[1]), int(parts[2]))))
        elif parts[0] == 'quit':
            loop.quit()
        write({'op': 'control', 'line': line})
    return True


def on_bus_acquired(connection, name):
    state['connection'] = connection
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    connection.register_object(PATH, node.interfaces[0], on_method_call, None, None)


def on_name_acquired(connection, name):
    write({'op': 'ready'})
    GLib.timeout_add(25, poll_control)


def on_name_lost(connection, name):
    write({'op': 'name-lost'})
    sys.exit(1)


loop = GLib.MainLoop()
Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE, on_bus_acquired, on_name_acquired, on_name_lost)
loop.run()
