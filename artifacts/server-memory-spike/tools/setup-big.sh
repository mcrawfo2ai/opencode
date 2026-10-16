#!/bin/bash
# like setup.sh but each project = 3.4k-file slice of the opencode tree, distinct root commit
source $(dirname $0)/env.sh
$(dirname $0)/setup.sh > /dev/null
for i in $(seq 1 ${NBIG:-20}); do
  d=$RUN/projects/p$i; rm -rf $d; mkdir -p $d; cd $d; git init -q
  git commit -q --allow-empty -m "root $i $RANDOM"
  cp -a $S/tpl/. $d/; mkdir -p src
  echo "# project $i" > README.md; printf 'export const x%s = 1\n' $i > src/index.ts; printf 'def util(x):\n    return x\n' > src/util.py
  git add -A; git commit -qm init
done
echo setup-big done
