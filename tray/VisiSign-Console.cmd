@echo off
title VisiSign Console
rem Opens the VisiSign admin command console ONLY (no web server). Safe to run
rem while the app/tray is already running — they share the same live database.
rem To run the server AND console together in one window, use Start-VisiSign.cmd.
"%~dp0VisiSign.exe" --console
