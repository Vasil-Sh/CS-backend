@echo off
cd /d d:\github\mathciq\backend
git add -A
git commit -m "feat: CS2 scraper on tips.gg as backup source"
git push
cd /d d:\github\mathciq
git add backend
git commit -m "chore: updated backend (CS2 scraper)"
git push
echo DONE
