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
    char c, previous = 0;
    while (read(STDIN_FILENO, &c, 1) == 1) {
        if (argc == 1 && c == '~' && (previous == '5' || previous == '6')) {
            top += previous == '5' ? -10 : 10;
            if (top < 0) top = 0;
            if (top > 200) top = 200;
            printf("\033[2J\033[Hnative history %03d\r\n", top);
        }
        previous = c;
    }
    return 0;
}
