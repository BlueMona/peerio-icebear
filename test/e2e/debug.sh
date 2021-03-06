#!/bin/bash

export PEERIO_REDUCE_SCRYPT_FOR_TESTS=1
export DEFAULT_TIMEOUT=-1

npm run test-build

node  --expose-gc --inspect-brk=9229 ./node_modules/cucumber/bin/cucumber-js test/e2e/spec \
                            -r test/e2e/code \
                            --tags '@debug' \
                            --exit
