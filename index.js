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

app.listen(80);

// all of our routes will be prefixed with /api
app.use('/api', router);

if (!config.delay)
    config.delay = 10;

var fayeClient;
if (config.fayeURL) {
    fayeClient = new faye.Client(config.fayeURL);
    fayeClient.connect();
}

// Display a new image every x seconds
var reload = setInterval(function() {nextImage();},config.delay * 1000);

function nextImage() {
    
    if (lastCameraEvent + 30000 > Date.now())
        return;

    var date = new Date();
    var hour = date.getHours();
    if (hour >= 22 || hour < 7)
        return;

    let imgFile = "";
    do {
        imgFile = slideShowList.pop();
        //console.log("Showing: ",imgFile);
    } while (slideShowList.length && imgFile.includes(path.sep) && !fs.existsSync(imgFile))

    if (imgFile) {
        console.log("Launching showimage.sh");
        spawn('/home/pi/node_pse_slideshow/showimage.sh',[imgFile,config.tmp_dir,config.cache_dir]);
    }
        //spawn('timeout',['-s','9','25','feh','-Z','-F','--auto-rotate','--hide-pointer','-x','-B','black', imgFile]);

    if (chrome) {
        chrome.kill();
        chrome = null;
    }

    if (slideShowList.length < 100) {
        fillSlideShowList();
    } 
    if (slideShowList.length < 40) {
        fillSlideShowListFromCache();
    } 
}

fillSlideShowListFromCache();

var subscriptionSaw = fayeClient.subscribe('/camera_saw', function(message) {
    console.log("Camera Event Received",message);

    if (message.liveFeedURL) {
        lastCameraEvent = Date.now();
        if (!chrome) {
            chrome = spawn('timeout',['600', 'chromium-browser', message.liveFeedURL, '--start-fullscreen', 
                         '--kiosk', '--incognito', '--noerrdialogs', '--disable-translate',
                         '--no-first-run','--fast','--fast-start','--disable-infobars',
                         '--disable-features=TranslateUI','--disk-cache-dir=/dev/null', "--no-sandbox",
                         '--force-device-scale-factor=' + message.liveFeedZoom]);
            chrome.stderr.on('data', (data) => {
                console.log(`stderr: ${data}`);
            });
        }
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
        tagQuery += "'" + config.onlyTheseTags[i].replace("'","''") + "'";
    }

    let sql = "select a.full_filepath, d.drive_path_if_builtin " +
          "from media_table a, tag_table b, tag_to_media_table c, volume_table d " +
          "where a.id = c.media_id and b.id = c.tag_id and a.volume_id = d.id and " +
          "a.mime_type='image/jpeg' and b.name not like 'zz%' and b.can_tag_media = 1 and " +
          "b.can_have_children = 0 and b.type_name not in ('autotag', 'history_print', 'pre_content_analysis_group') and " +
          "b.name in (" + tagQuery + ") " +
          "order by random() limit 200";

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

router.get('/getconfig', function(req, res) {
    res.json(config);
});

router.get('/getcategories', function(req, res) {
    getDB().all("select distinct e.name as parent, c.name as name, c.id " +
            "from tag_table c, tag_to_media_table d, tag_table e " +
            "where c.id = d.tag_id and e.id = c.parent_id and c.can_have_children = 0 and " +
            "c.can_tag_media = 1 and e.name not in " +
            "('history_email_category','history_print_category','rejected_face_ns','Smart Tags','person_ns','Imported Keyword Tags','autotag_category_place','autotag_category_general','autotag_category_ok','autotag_category_worth','autotag_category_event') " +
            "order by (e.name != 'Family')*7+(e.name != 'Friends')*6 + (e.name!='Places')*5+(e.name!='Events'), e.id, c.name", function(err, rows) {
        db.close();
        db = null;

        if (err)
            console.log("getcategories SQL error:", err)

        for (let i = 0;i < rows.length;i ++) {
            if (rows[i].parent == 'event_ns')
                rows[i].parent = 'Events';
            if (rows[i].parent == 'place_ns')
                rows[i].parent = 'Places';
        }

        //console.log("Categories:", rows);
        res.json(rows);
    });
});

router.get('/setconfig', function(req, res) {
    if (typeof req.query.delay  != 'undefined')
        config.delay = req.query.delay;

    if (typeof req.query.onlyTheseTags != 'undefined' && Array.isArray(req.query.onlyTheseTags)) {
        if (JSON.stringify(req.query.onlyTheseTags) != JSON.stringify(config.onlyTheseTags)) {
            slideShowList.length = Math.min(10,slideShowList.length);
            console.log("New config - slideshow list now at: ",slideShowList.length);
        }

        config.onlyTheseTags = req.query.onlyTheseTags;
    }

    saveConfig();
    res.json({rc:true});
});

function saveConfig () {
    clearTimeout(reload);
    reload = setInterval(function() {nextImage();},config.delay * 1000);

    fs.writeFile('config.json',JSON.stringify(config,null,2), (err) => {
        if (err) {
            console.log("Error writing config file:",err);
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
        let re = new RegExp(config.filename_replace[i].replace, 'g');
        filename = filename.replace(re,config.filename_replace[i].with);
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

