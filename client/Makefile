CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wextra -std=c11

all: cosh

cosh: cosh.c
	$(CC) $(CFLAGS) -o $@ cosh.c

# Fully static build for easy deployment to the server (needs static libc).
static:
	$(CC) $(CFLAGS) -static -o cosh cosh.c


clean:
	rm -f cosh *.o

.PHONY: all static clean
