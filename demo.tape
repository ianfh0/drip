# drip — launch demo tape
#
# Tweak this file and re-run:   vhs demo.tape
# It'll overwrite demo.gif in this directory.
#
# Syntax cheat sheet:
#   Type "..."       — types the string as if at a keyboard
#   Enter            — presses return
#   Space            — presses spacebar (drip's skip-ahead key)
#   Down / Up        — arrow keys (for the level menu)
#   Sleep 2s         — waits 2 seconds before the next step
#   Set FontSize 16  — adjust sizing, theme, etc at the top
#
# Timings below are tuned for a ~16-second gif that shows:
#   onboard → first drip streams in → space-skip → instant next → space-skip → instant third → quit

Output demo.gif

Set FontSize 32
Set Width 2000
Set Height 1200
Set Theme "Dracula"
Set TypingSpeed 40ms

# Clear any prior shell artifacts.
Hide
Type "clear" Enter
Show

# Launch drip.
Type "./drip.js"
Sleep 400ms
Enter

# Topic prompt shows.
Sleep 2200ms

Type "neural networks"
Sleep 500ms
Enter

# Level menu shows. Default highlights intermediate — just hit Enter.
Sleep 1200ms
Enter

# First drip typewriters in (~1-2s).
Sleep 4s

# Show the instant-advance feature: space jumps to the pre-generated next drip.
Space
Sleep 3s

# One more skip to demonstrate the rhythm.
Space
Sleep 3500ms

# Quit back to the topic picker (briefly visible), then end.
Type "q"
Sleep 800ms
