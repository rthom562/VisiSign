@echo off
title VisiSign
rem All-in-one: runs the VisiSign web server AND the command console together in
rem this one window (one program, one process). The kiosk, reservations and admin
rem pages are served while you type commands at the visisign> prompt.
rem Type /help for commands, /exit to stop everything.
rem
rem Note: use EITHER this window OR the tray (VisiSign.vbs) at a time — both start
rem a server on the same port.
"%~dp0VisiSign.exe" --serve-console
