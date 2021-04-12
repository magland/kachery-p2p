#!/bin/bash
# This file was automatically generated by jinjaroot. Do not edit directly.


set -e

# check that we have a clean working directory
if [ -z "$(git status --porcelain)" ]; then 
  echo "Working directory is clean"
else
  echo "Working directory is not clean (use git status)"
  exit 1
fi

# verify that code generation is up-to-date (if not throws an error)
jinjaroot verify

# run pre-publish-tasks.sh
.vscode/tasks/pre-publish-tasks.sh

cd .

# remove the dist folder
rm -rf dist
# create the package for dist
python setup.py sdist
# Show size of dist
du -sh dist

# Confirm publish
while true; do
    read -p "Publish version 0.8.18 (y/n)?" yn
    case $yn in
        [Yy]* ) break;;
        [Nn]* ) echo "aborting"; exit;;
        * ) echo "Please answer yes or no.";;
    esac
done


# upload the package to pypi
twine upload ./dist/*

# Tag this commit
git tag v0.8.18

echo "Tagged as v0.8.18"
echo "You should increment the version now in jinjaroot.yaml"