@echo off
setlocal
rem Starthjälp för Windows: kör fältprovet från skriptets egen katalog.
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0"
"%ProgramFiles%\Git\bin\bash.exe" run-with-logs.sh
pause
endlocal
