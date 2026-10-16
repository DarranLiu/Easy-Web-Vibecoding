#include <stdio.h>
#include <termios.h>
#include <unistd.h>

/* Offline full-screen transcript fixture. No Codex account or model is used. */
int main(int argc, char **argv) {
    (void)argv;
    struct termios raw;
    if (tcgetattr(STDIN_FILENO, &raw) != 0) return 1;
    cfmakeraw(&raw);
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    setbuf(stdout, NULL);
    if (argc > 1) {
        for (int i = 0; i < 300; i++) printf("inline history %03d\r\n", i);
    } else {
        printf("\033[?1049h\033[2J\033[Hnative history 200\r\n");
    }
    int top = 200;
    char c, report[64];
    size_t length = 0;
    while (read(STDIN_FILENO, &c, 1) == 1) {
        if (c == '\033') length = 0;
        if (length + 1 >= sizeof(report)) length = 0;
        report[length++] = c;
        report[length] = '\0';
        unsigned button, column, row;
        if (argc == 1 && c == 'M'
                && sscanf(report, "\033[<%u;%u;%uM", &button, &column, &row) == 3
                && (button == 64 || button == 65) && column == 1 && row >= 1 && row <= 2) {
            top += button == 64 ? -3 : 3;
            if (top < 0) top = 0;
            if (top > 200) top = 200;
            printf("\033[2J\033[Hnative history %03d\r\n", top);
        }
    }
    return 0;
}
