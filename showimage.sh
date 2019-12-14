tmpjpg=`echo -n $1 | md5sum | cut -f1 -d" "`.jpg
if [ -f $3/$1 ]; then
   tmpjpg=$1
elif [ ! -f $3/$tmpjpg ]; then
    filename=$(basename -- "$1")
    cp "$1" $2
    mv "$2/$filename" $2/$tmpjpg
    convert $2/$tmpjpg -resize 1920x1080 -quality 60 $3/$tmpjpg
    rm $2/$tmpjpg
fi
timeout -s 9 20 feh -Z -F --auto-rotate --hide-pointer -x -B black $3/$tmpjpg

