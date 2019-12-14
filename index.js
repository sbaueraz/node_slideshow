#!/bin/env node
var config = require('./config');
const express = require('express');
const app = express();
const path = require('path');
const router = express.Router();
const fs = require('fs')
const sharp = require("sharp");
const {spawn} = require('child_process');
const exec = require('child_process').exec;
const faye = require('faye');

var sqlite3 = require('sqlite3').verbose();
var db = null;
var lastDBAccess = 0;
var lastCameraEvent = 0;
var filling = false;
var chrome;

var extExtract = /(?:\.([^.]+))?$/;

var slideShowList = [];

app.use('/js', express.static(__dirname + '/js'));
app.use('/img', express.static(__dirname + '/img'));
app.use('/css', express.static(__dirname + '/css'));
app.use(express.static(__dirname + '/public'));

app.listen(3000);

// all of our routes will be prefixed with /api
app.use('/api', router);

var fayeClient;
if (config.fayeURL) {
    fayeClient = new faye.Client(config.fayeURL);
    fayeClient.connect();
}

// Display a new image every x seconds
setInterval(function() {
    
    if (lastCameraEvent + 30000 > Date.now())
        return;

    var date = new Date();
    var hour = date.getHours();
    if (hour >= 22 || hour < 7)
        return;

    if (chrome) {
        chrome.kill();
        chrome = null;
    }

    let imgFile = "";
    do {
        imgFile = slideShowList.pop();
        //console.log("Showing: ",imgFile);
    } while (slideShowList.length && imgFile.includes(path.sep) && !fs.existsSync(imgFile))

    if (imgFile)
        spawn('showimage.sh',[imgFile,config.tmp_dir,config.cache_dir]);
        //spawn('timeout',['-s','9','25','feh','-Z','-F','--auto-rotate','--hide-pointer','-x','-B','black', imgFile]);

    if (slideShowList.length < 100) {
        fillSlideShowList();
    } 
    if (slideShowList.length < 40) {
        fillSlideShowListFromCache();
    } 
},10 * 1000);

fillSlideShowListFromCache();

var subscriptionSaw = fayeClient.subscribe('/camera_saw', function(message) {
    console.log("Camera Event Received",message);

    if (message.liveFeedURL) {
        lastCameraEvent = Date.now();
        if (!chrome)
            chrome = spawn('timeout',['180', 'chromium-browser', message.liveFeedURL, '--start-fullscreen', 
                         '--kiosk', '--incognito', '--noerrdialogs', '--disable-translate',
                         '--no-first-run','--fast','--fast-start','--disable-infobars',
                         '--disable-features=TranslateUI','--disk-cache-dir=/dev/null',
                         '--force-device-scale-factor=' + message.liveFeedZoom]);
    }

});

function fillSlideShowListFromCache() {
    if (filling)
        return;

    filling = true;

    var child = exec('ls ' + config.cache_dir + ' | sort -R | head -75', function(error, stdout, stderr) {
        if (error)
            console.log("Exec error: ", error);
        if (stderr)
            console.log("Exec stderr: ", stderr);
        if (stdout) {
            var lines = stdout.split("\n");
            for (var i = 0;i < lines.length;i ++) {
                if (lines[i])
                    slideShowList.push(lines[i]);
            }
        }
        filling = false
        console.log("Slideshow list now at (from cache): ",slideShowList.length);
    });
}

function fillSlideShowList() {
    if (filling)
        return;

    filling = true;

    let tagQuery = "";
    for (let i = 0;i < config.onlyTheseTags.length;i ++) {
        if (tagQuery)
            tagQuery += ",";
        tagQuery += "'" + config.onlyTheseTags[i] + "'";
    }

    let sql = "select a.full_filepath, d.drive_path_if_builtin " +
          "from media_table a, tag_table b, tag_to_media_table c, volume_table d " +
          "where a.id = c.media_id and b.id = c.tag_id and a.volume_id = d.id and " +
          "a.mime_type='image/jpeg' and b.name not like 'zz%' and b.can_tag_media = 1 and " +
          "b.can_have_children = 0 and b.type_name not in ('autotag', 'history_print', 'pre_content_analysis_group') and " +
          "b.name in (" + tagQuery + ") " +
          "order by random() limit 200";

//console.log("New SQL",sql);

    //getDB().all("select a.full_filepath, b.drive_path_if_builtin from media_table a, volume_table b " + 
    //            "where a.mime_type='image/jpeg' and a.volume_id = b.id order by random() limit 100", function(err, rows) {
    getDB().all(sql, function(err, rows) {
        filling = false;
        db.close();
        db = null;

        if (err)
            console.log("fillSlideShowList SQL error:", err);

        if (rows && rows.length) {
	        console.log("Returned ",rows.length,"rows");
            for (let i = 0;i < rows.length;i ++) {
                let fileName = rows[i].drive_path_if_builtin;
                if (fileName)
                    fileName = joinPaths(fileName, rows[i].full_filepath);
                else
                    fileName = joinPaths(config.default_drive, rows[i].full_filepath);
    
                slideShowList.push(fileName);
            }

            console.log("Slideshow list now at: ",slideShowList.length);
        } else {
            console.log("No image matches");
        }
    });
}
 
function returnResizedFile(image, scale, res) {
    if (!scale || scale < 0)
        scale = 1;
    else if (scale > 4)
        scale = 4;
    scale *= 100;

    if (!fs.existsSync(image)) {
        console.log("Unable to find: ", image)
        image = "img/image-missing.jpg";
    }

    sharp(image).resize(scale, scale, {kernel: sharp.kernel.nearest}).crop(sharp.gravity.north).rotate().toBuffer(function(err, data) {
        if (err) {
            console.log("Unable to resize ", image, "error: ", err);
            returnFile("img/image-missing.jpg");
        } else {
            res.writeHead(200, {'Content-Type': 'image/jpeg'});
            res.end(data); // Send the file data to the browser.
        }
    });
}

function getDB() {
    if (!db) {
        console.log("Creating connection to database ",config.database_file);
        db = new sqlite3.Database(config.database_file, sqlite3.OPEN_READONLY);
    }

    lastDBAccess = new Date();
    return db;
}

function fileNameFilter(filename) {
    if (!config.filename_replace)
        return filename;

    for (let i = 0;i < config.filename_replace.length; i++) {
        if (!config.filename_replace[i].re)
            config.filename_replace[i].re = new RegExp(config.filename_replace[i].replace, 'g');
        filename = filename.replace(config.filename_replace[i].re,config.filename_replace[i].with);
    }

    return filename;
}

function joinPaths(beg, end) {
    if (path.sep == '/') {
        beg = beg.replace(/\\/g, "/");
        end = end.replace(/\\/g, "/");
    } else {
        beg = beg.replace(/\//g, "\\");
        end = end.replace(/\//g, "\\");
    }

    var ret = beg;

    if (!ret.endsWith(path.sep) && !end.startsWith(path.sep))
        ret += path.sep;
    ret += end;

    return fileNameFilter(ret);
}

process.on('uncaughtException', function (err) {
    filling = false;
    console.log('Caught exception: ', err);
});

