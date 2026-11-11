# Parse quoted arguments without evaluating shell expansions or commands.
function fail() {
    print "ERROR: FF_CUSTOM_ARGS contains an incomplete quote, escape or unsupported argument." > "/dev/stderr"
    exit 1
}

BEGIN {
    input = ENVIRON["FF_CUSTOM_ARGS"]
    if (input ~ /[\r\n]/) fail()
    quote = ""
    word = ""
    started = 0
    count = 0
    for (i = 1; i <= length(input); i++) {
        char = substr(input, i, 1)
        if (quote == "'") {
            if (char == "'") quote = ""
            else word = word char
        } else if (char == "\\") {
            if (i == length(input)) fail()
            nextchar = substr(input, ++i, 1)
            if (quote == "\"" && nextchar !~ /["\\$`]/) word = word "\\"
            word = word nextchar
            started = 1
        } else if (quote == "\"") {
            if (char == "\"") quote = ""
            else word = word char
        } else if (char == "'" || char == "\"") {
            quote = char
            started = 1
        } else if (char ~ /[ \t]/) {
            if (started) {
                if (word == "") fail()
                words[++count] = word
                word = ""
                started = 0
            }
        } else {
            word = word char
            started = 1
        }
    }
    if (quote != "") fail()
    if (started) {
        if (word == "") fail()
        words[++count] = word
    }
    for (i = 1; i <= count; i++) print words[i]
}
