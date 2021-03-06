'use strict';

const Promise = require("bluebird");
const fs = Promise.promisifyAll(require("fs"));
const moment = require("moment");
const groupBy = require("group-by");
const path = require("path");
const defaultValue = require("default-value");

const createDateFolderCache = require("../date-folder-cache");
const groupPicturesByDate = require("./group-pictures-by-date");
const paginateDates = require("./paginate-dates");

module.exports = function createPhotoManager({photoPath, cacheDuration, paginationThreshold}) {
	let dateFolderCache = createDateFolderCache(photoPath);
	let knownPictures = [];
	let knownDates = [];
	let knownPictureMap = new Map();
	let dateReferenceMap = new Map();
	let groupedPictures = [];
	let paginatedPictures = [];
	let lastUpdate;

	function updateData() {
		return Promise.try(() => {
			return fs.readdirAsync(photoPath);
		}).filter((entry) => {
			return Promise.try(() => {
				return fs.statAsync(path.join(photoPath, entry));
			}).then((stat) => {
				return stat.isDirectory();
			});
		}).then((dates) => {
			return dates.slice().sort().reverse();
		}).tap((sortedDates) => {
			knownDates = sortedDates;

			let lastDate;

			sortedDates.forEach((date) => {
				let dateObject = {
					previous: lastDate
				};

				dateReferenceMap.set(date, dateObject);

				if (lastDate != null) {
					dateReferenceMap.get(lastDate).next = dateObject;
				}

				lastDate = date;
			});
		}).map((date) => {
			return Promise.try(() => {
				return dateFolderCache(date);
			}).then((entries) => {
				return {
					date: date,
					momentDate: moment(date, "YYYYMMDD"),
					entries: entries.slice().sort().reverse()
				};
			});
		}).then((dates) => {
			let lastEntry;

			knownPictures = dates.reduce((pictures, date) => {
				return pictures.concat(date.entries.map((entry) => {
					let picture = {
						date: date,
						dateString: date.date,
						filename: entry,
						previous: lastEntry
					}

					if (lastEntry != null) {
						lastEntry.next = picture;
					}

					lastEntry = picture;
					return picture;
				}));
			}, []);

			knownPictureMap = new Map();

			dates.forEach((date) => {
				knownPictureMap.set(date.date, new Map());
			});

			knownPictures.forEach((picture) => {
				knownPictureMap.get(picture.date.date).set(picture.filename, picture);
			});

			groupedPictures = groupPicturesByDate(knownPictures);
			paginatedPictures = paginateDates(groupedPictures, paginationThreshold);
		});
	}

	function maybeUpdateData() {
		let needsUpdate;

		if (lastUpdate == null) {
			needsUpdate = true;
		} else {
			let cacheExpiry = lastUpdate + defaultValue(cacheDuration, 5 * 1000);
			needsUpdate = (Date.now() > cacheExpiry);
		}

		if (needsUpdate) {
			return Promise.try(() => {
				return updateData();
			}).then(() => {
				lastUpdate = Date.now();
			});
		}
	}

	return {
		getDates: function () {
			return Promise.try(() => {
				return maybeUpdateData();
			}).then(() => {
				return knownDates;
			});
		},
		getDateReferences: function (date) {
			return Promise.try(() => {
				return maybeUpdateData();
			}).then(() => {
				return dateReferenceMap.get(date);
			});
		},
		getDatesWithPictures: function () {
			return Promise.try(() => {
				return maybeUpdateData();
			}).then(() => {
				return groupedPictures;
			});
		},
		getPaginatedDatesWithPictures: function () {
			return Promise.try(() => {
				return this.getDatesWithPictures();
			}).then((dates) => {
				return paginatedPictures;
			});
		},
		getPicturesForDate: function (date) {
			return Promise.try(() => {
				return maybeUpdateData();
			}).then(() => {
				return knownPictures.filter((picture) => picture.date === date);
			});
		},
		getPictures: function () {
			return Promise.try(() => {
				return maybeUpdateData();
			}).then(() => {
				return knownPictures;
			});
		},
		getPicture: function (date, filename) {
			return Promise.try(() => {
				return maybeUpdateData();
			}).then(() => {
				return knownPictureMap.get(date).get(filename);
			});
		}
	}
};
