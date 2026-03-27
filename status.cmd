@echo off
cd /d "%~dp0"
node .\src\cli.mjs status .\webot.config.json
