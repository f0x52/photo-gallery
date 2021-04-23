'use strict';

const Promise = require("bluebird");
const express = require("express");
const expressPromiseRouter = require("express-promise-router");
const path = require("path");
const fs = Promise.promisifyAll(require("fs"));
const defaultValue = require("default-value");
const unhandledError = require("unhandled-error");
const bhttp = require("bhttp");
const cookieParser = require("cookie-parser");

const config = require("./config.json");
const createThumbnailer = require("./lib/thumbnailer");
const createPhotoManager = require("./lib/photo-manager");
const validatePhotoFilename = require("./lib/validate/photo-filename");
const validateDateFolderName = require("./lib/validate/date-folder");
const validateNumber = require("./lib/validate/number");
const ValidationError = require("./lib/validate/error");
const ThumbnailError = require("./lib/thumbnailer/error");
const { verify } = require("crypto");

let errorHandler = unhandledError((err, context) => {
	console.log("Unhandled error!", err);
});

let thumbnailer = createThumbnailer(path.join(__dirname, "thumbnails"), config.pictureFolder, {width: config.thumbnails.width, height: config.thumbnails.height, quality: config.thumbnails.quality});

let photoManager = createPhotoManager({
	photoPath: config.pictureFolder,
	paginationThreshold: config.paginationThreshold
});

let app = express();

app.locals.pathPrefix = config.pathPrefix;

app.set("view engine", "pug");
app.set("views", path.join(__dirname, "views"));

// NOTE: This means that any proxied IP header is trusted! While the client IP is not currently used anywhere, this means that anyone who can connect to the service directly can spoof their IP.
app.set("trust proxy", true);

app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use("/photos", express.static(config.pictureFolder));

let router = expressPromiseRouter();

function verifyMediaWikiAuth(cookies) {
	return Promise.try(() => {
		let concatCookies = "";
		Object.entries(cookies).forEach(([name, val]) => {
			concatCookies += `${name}=${val};`;
		});
		return bhttp.get(`${config.mediawikiUrl}Special:Preferences`, {headers: {Cookie: concatCookies}});
	}).then(({request, redirectHistory}) => {
		if (redirectHistory.length == 0 && !request.options.path.includes("Special%3AUserLogin")) {
			return true;
		} else {
			return false;
		}
	})
}

router.get("/mediaWikiAuth", (req, res) => {
	return Promise.try(() => {
		let nameCookie = req.cookies[`${config.mediawikiCookie}_UserName`];
		if (nameCookie != undefined) {
			console.log("Trying MediaWiki Cookies for", nameCookie);
			return verifyMediaWikiAuth(req.cookies);
		} else {
			return false;
		}
	}).then((auth) => {
		if (auth) {
			return res.status(200).send("Authenticated");
		} else {
			return res.status(401).send("No, or invalid MediaWiki cookies found");
		}
	});
});

router.get("/latest", (req, res) => {
	return Promise.try(() => {
		if (req.query.amount != null) {
			validateNumber(req.query.amount);
		}

		return photoManager.getPictures();
	}).then((pictures) => {
		let amount = parseInt(defaultValue(req.query.amount, 3));

		res.json({
			latest: pictures.slice(0, amount).map((picture) => {
				return {
					date: picture.date.momentDate.format("YYYY-MM-DD"),
					filename: picture.filename,
					url: `${config.pathPrefix}/view/${picture.date.date}/${picture.filename}`,
					thumbnail: `${config.pathPrefix}/thumbnails/${picture.date.date}/${picture.filename}`
				};
			})
		});
	});
});

router.get("/:page?", (req, res) => {
	return Promise.try(() => {
		if (req.params.page != null) {
			validateNumber(req.params.page);
		}

		return photoManager.getPaginatedDatesWithPictures();
	}).then((dates) => {
		let pageParam = defaultValue(req.params.page, 1);
		let pageNumber = parseInt(pageParam) - 1;

		if (pageNumber < 0 || pageNumber > dates.length - 1) {
			res.status(404).send("404 not found");
		} else {
			res.render("index", {
				dates: dates[pageNumber],
				currentPage: pageNumber + 1,
				totalPages: dates.length
			});
		}
	});
});

router.get("/view/:date/:filename", (req, res) => {
	return Promise.try(() => {
		validateDateFolderName(req.params.date);
		validatePhotoFilename(req.params.filename);

		return photoManager.getPicture(req.params.date, req.params.filename);
	}).then((photo) => {
		if (photo == null) {
			res.status(404).send("404 not found");
		} else {
			res.render("view", {
				photo: photo,
				previousPhoto: photo.previous,
				nextPhoto: photo.next,
				// NOTE: The below does not currently work when the user-facing HTTPd is running on a non-standard port!
				absoluteThumbnail: `${req.protocol}://${req.host}${config.pathPrefix}/thumbnails/${photo.date.date}/${photo.filename}`
			});
		}
	});
});

router.get("/thumbnails/:date/:filename", (req, res) => {
	return Promise.try(() => {
		validateDateFolderName(req.params.date);
		validatePhotoFilename(req.params.filename);

		return thumbnailer(req.params.date, req.params.filename);
	}).then((stream) => {
		stream.pipe(res);
	}).catch((err) => {
		if (/Unable to open file/.test(err.message)) {
			res.status(404).send("404 not found");
		} else {
			throw err;
		}
	});
});

app.use(router);

app.use((err, req, res, next) => {
	console.log('a');
	if (err instanceof ValidationError) {
		res.status(404).send("404 not found");
	} else if (err instanceof ThumbnailError) {
		res.status(500).send("Failed to generate thumbnail - not an image file?");
	} else {
		errorHandler.report(err, {
			req: req,
			res: res
		});
	}
});

app.listen(config.listen.port, () => {
	console.log(`Server listening on port ${config.listen.port}...`);
});
