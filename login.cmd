@echo off
cd /d "%~dp0"
node .\src\cli.mjs login .\webot.config.json
