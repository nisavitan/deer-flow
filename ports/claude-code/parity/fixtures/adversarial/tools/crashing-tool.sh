#!/bin/bash
# Adversarial fixture: always crashes with a nonzero exit and stderr noise.
echo "FATAL: simulated tool crash (fixture)" >&2
exit 2
