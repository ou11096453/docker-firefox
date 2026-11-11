function fail(variable, reason) {
    failed = 1
    print "ERROR: " variable ": " reason > "/dev/stderr"
    exit 1
}

function is_string(value,    i, char, escape, hex) {
    if (length(value) < 2 || substr(value, 1, 1) != "\"" ||
            substr(value, length(value), 1) != "\"") return 0
    for (i = 2; i < length(value); i++) {
        char = substr(value, i, 1)
        if (char ~ /[[:cntrl:]]/ || char == "\"") return 0
        if (char == "\\") {
            if (++i >= length(value)) return 0
            escape = substr(value, i, 1)
            if (escape == "u") {
                hex = substr(value, i + 1, 4)
                if (length(hex) != 4 || hex ~ /[^0-9a-fA-F]/ ||
                        i + 4 >= length(value)) return 0
                i += 4
            } else if (escape !~ /^["\\\/bfnrt]$/) return 0
        }
    }
    return 1
}

BEGIN {
    for (variable in ENVIRON) {
        if (variable !~ /^FF_PREF_/) continue
        setting = ENVIRON[variable]
        if (setting == "") continue
        separator = index(setting, "=")
        if (separator) {
            name = substr(setting, 1, separator - 1)
            value = substr(setting, separator + 1)
        } else {
            name = setting
            value = ""
        }
        if (name == "" || name ~ /["\\[:cntrl:]]/)
            fail(variable, "invalid preference name")
        if (name in values) fail(variable, "duplicate preference name")
        if (value == "") value = "\"\""
        if (value != "UNSET" && value != "true" && value != "false" &&
                !is_string(value)) {
            if (value !~ /^-?(0|[1-9][0-9]*)$/ ||
                    value + 0 < -2147483648 || value + 0 > 2147483647)
                fail(variable, "expected a quoted string, 32-bit integer, boolean or UNSET")
        }
        values[name] = value
    }
}

{
    line = $0
    if (line ~ /^[ \t]*user_pref\("/) {
        sub(/^[ \t]*user_pref\("/, "", line)
        closing = index(line, "\"")
        name = substr(line, 1, closing - 1)
        if (closing && substr(line, closing + 1, 1) == "," && name in values) next
    }
    print
}

END {
    if (failed) exit 1
    for (name in values) {
        if (values[name] != "UNSET")
            printf "user_pref(\"%s\", %s);\n", name, values[name]
    }
}
