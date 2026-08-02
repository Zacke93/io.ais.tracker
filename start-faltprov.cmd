@echo off
rem Lokal starthjälp (ej committad): säkrar PATH och kör fältprovsskriptet.
set "PATH=C:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm;%PATH%"
cd /d C:\Dev\AIS_App
"C:\Program Files\Git\bin\bash.exe" run-with-logs.sh
pause
