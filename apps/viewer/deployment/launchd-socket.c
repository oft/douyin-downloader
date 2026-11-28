/* Same socket activation pattern as ~/code/music-player/deployment/launchd-socket.c. */
#include <launch.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    int *fds = NULL;
    size_t count = 0;
    int error = launch_activate_socket("Listener", &fds, &count);
    if (error || count != 1) {
        fprintf(stderr, "launchd socket activation failed: %d\n", error);
        free(fds);
        return 1;
    }
    int fd = fds[0];
    free(fds);
    if (fd != 3) {
        if (dup2(fd, 3) < 0) return 1;
        close(fd);
    }
    if (fcntl(3, F_SETFD, 0) < 0 || setenv("VIDEO_LISTEN_FD", "3", 1) < 0) return 1;
    execl(argv[1], argv[1], argv[2], (char *)NULL);
    perror("exec node");
    return 1;
}
