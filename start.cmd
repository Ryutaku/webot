@echo off
cd /d "%~dp0"
node .\src\cli.mjs start .\webot.config.json
