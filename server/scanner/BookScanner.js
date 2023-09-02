const uuidv4 = require("uuid").v4
const { Sequelize } = require('sequelize')
const { LogLevel } = require('../utils/constants')
const { getTitleIgnorePrefix, areEquivalent } = require('../utils/index')
const { parseOpfMetadataXML } = require('../utils/parsers/parseOpfMetadata')
const { parseOverdriveMediaMarkersAsChapters } = require('../utils/parsers/parseOverdriveMediaMarkers')
const abmetadataGenerator = require('../utils/generators/abmetadataGenerator')
const parseNameString = require('../utils/parsers/parseNameString')
const globals = require('../utils/globals')
const AudioFileScanner = require('./AudioFileScanner')
const Database = require('../Database')
const { readTextFile } = require('../utils/fileUtils')
const AudioFile = require('../objects/files/AudioFile')
const CoverManager = require('../managers/CoverManager')
const fsExtra = require("../libs/fsExtra")

/**
 * Metadata for books pulled from files
 * @typedef BookMetadataObject
 * @property {string} title
 * @property {string} titleIgnorePrefix
 * @property {string} subtitle
 * @property {string} publishedYear
 * @property {string} publisher
 * @property {string} description
 * @property {string} isbn
 * @property {string} asin
 * @property {string} language
 * @property {string[]} narrators
 * @property {string[]} genres
 * @property {string[]} tags
 * @property {string[]} authors
 * @property {{name:string, sequence:string}[]} series
 * @property {{id:number, start:number, end:number, title:string}[]} chapters
 * @property {boolean} explicit
 * @property {boolean} abridged
 * @property {string} coverPath
 */

class BookScanner {
  constructor() { }

  /**
   * @param {import('../models/LibraryItem')} existingLibraryItem 
   * @param {import('./LibraryItemScanData')} libraryItemData 
   * @param {import('./LibraryScan')} libraryScan 
   * @returns {import('../models/LibraryItem')}
   */
  async rescanExistingBookLibraryItem(existingLibraryItem, libraryItemData, libraryScan) {
    /** @type {import('../models/Book')} */
    const media = await existingLibraryItem.getMedia({
      include: [
        {
          model: Database.authorModel,
          through: {
            attributes: ['id', 'createdAt']
          }
        },
        {
          model: Database.seriesModel,
          through: {
            attributes: ['id', 'sequence', 'createdAt']
          }
        }
      ],
      order: [
        [Database.authorModel, Database.bookAuthorModel, 'createdAt', 'ASC'],
        [Database.seriesModel, 'bookSeries', 'createdAt', 'ASC']
      ]
    })

    let hasMediaChanges = libraryItemData.hasAudioFileChanges
    if (libraryItemData.hasAudioFileChanges || libraryItemData.audioLibraryFiles.length !== media.audioFiles.length) {
      // Filter out audio files that were removed
      media.audioFiles = media.audioFiles.filter(af => !libraryItemData.checkAudioFileRemoved(af))

      // Update audio files that were modified
      if (libraryItemData.audioLibraryFilesModified.length) {
        let scannedAudioFiles = await AudioFileScanner.executeMediaFileScans(existingLibraryItem.mediaType, libraryItemData, libraryItemData.audioLibraryFilesModified)
        media.audioFiles = media.audioFiles.map((audioFileObj) => {
          let matchedScannedAudioFile = scannedAudioFiles.find(saf => saf.metadata.path === audioFileObj.metadata.path)
          if (!matchedScannedAudioFile) {
            matchedScannedAudioFile = scannedAudioFiles.find(saf => saf.ino === audioFileObj.ino)
          }

          if (matchedScannedAudioFile) {
            scannedAudioFiles = scannedAudioFiles.filter(saf => saf !== matchedScannedAudioFile)
            const audioFile = new AudioFile(audioFileObj)
            audioFile.updateFromScan(matchedScannedAudioFile)
            return audioFile.toJSON()
          }
          return audioFileObj
        })
        // Modified audio files that were not found on the book
        if (scannedAudioFiles.length) {
          media.audioFiles.push(...scannedAudioFiles)
        }
      }

      // Add new audio files scanned in
      if (libraryItemData.audioLibraryFilesAdded.length) {
        const scannedAudioFiles = await AudioFileScanner.executeMediaFileScans(existingLibraryItem.mediaType, libraryItemData, libraryItemData.audioLibraryFilesAdded)
        media.audioFiles.push(...scannedAudioFiles)
      }

      // Add audio library files that are not already set on the book (safety check)
      let audioLibraryFilesToAdd = []
      for (const audioLibraryFile of libraryItemData.audioLibraryFiles) {
        if (!media.audioFiles.some(af => af.ino === audioLibraryFile.ino)) {
          libraryScan.addLog(LogLevel.DEBUG, `Existing audio library file "${audioLibraryFile.metadata.relPath}" was not set on book "${media.title}" so setting it now`)

          audioLibraryFilesToAdd.push(audioLibraryFile)
        }
      }
      if (audioLibraryFilesToAdd.length) {
        const scannedAudioFiles = await AudioFileScanner.executeMediaFileScans(existingLibraryItem.mediaType, libraryItemData, audioLibraryFilesToAdd)
        media.audioFiles.push(...scannedAudioFiles)
      }

      media.audioFiles = AudioFileScanner.runSmartTrackOrder(existingLibraryItem.relPath, media.audioFiles)

      media.duration = 0
      media.audioFiles.forEach((af) => {
        if (!isNaN(af.duration)) {
          media.duration += af.duration
        }
      })

      media.changed('audioFiles', true)
    }

    // Check if cover was removed
    if (media.coverPath && !libraryItemData.imageLibraryFiles.some(lf => lf.metadata.path === media.coverPath)) {
      media.coverPath = null
      hasMediaChanges = true
    }

    // Check if cover is not set and image files were found
    if (!media.coverPath && libraryItemData.imageLibraryFiles.length) {
      // Prefer using a cover image with the name "cover" otherwise use the first image
      const coverMatch = libraryItemData.imageLibraryFiles.find(iFile => /\/cover\.[^.\/]*$/.test(iFile.metadata.path))
      media.coverPath = coverMatch?.metadata.path || libraryItemData.imageLibraryFiles[0].metadata.path
      hasMediaChanges = true
    }

    // Check if ebook was removed
    if (media.ebookFile && (libraryScan.library.settings.audiobooksOnly || libraryItemData.checkEbookFileRemoved(media.ebookFile))) {
      media.ebookFile = null
      hasMediaChanges = true
    }

    // Check if ebook is not set and ebooks were found
    if (!media.ebookFile && !libraryScan.library.settings.audiobooksOnly && libraryItemData.ebookLibraryFiles.length) {
      // Prefer to use an epub ebook then fallback to the first ebook found
      let ebookLibraryFile = libraryItemData.ebookLibraryFiles.find(lf => lf.metadata.ext.slice(1).toLowerCase() === 'epub')
      if (!ebookLibraryFile) ebookLibraryFile = libraryItemData.ebookLibraryFiles[0]
      // Ebook file is the same as library file except for additional `ebookFormat`
      ebookLibraryFile.ebookFormat = ebookLibraryFile.metadata.ext.slice(1).toLowerCase()
      media.ebookFile = ebookLibraryFile
      media.changed('ebookFile', true)
      hasMediaChanges = true
    }

    // Check/update the isSupplementary flag on libraryFiles for the LibraryItem
    let libraryItemUpdated = false
    for (const libraryFile of existingLibraryItem.libraryFiles) {
      if (globals.SupportedEbookTypes.includes(libraryFile.metadata.ext.slice(1).toLowerCase())) {
        if (media.ebookFile && libraryFile.ino === media.ebookFile.ino) {
          if (libraryFile.isSupplementary !== false) {
            libraryFile.isSupplementary = false
            libraryItemUpdated = true
          }
        } else if (libraryFile.isSupplementary !== true) {
          libraryFile.isSupplementary = true
          libraryItemUpdated = true
        }
      }
    }
    if (libraryItemUpdated) {
      existingLibraryItem.changed('libraryFiles', true)
      await existingLibraryItem.save()
    }

    // TODO: When metadata file is stored in /metadata/items/{libraryItemId}.[abs|json] we should load this
    // TODO: store an additional array of metadata keys that the user has changed manually so we know what not to override
    const bookMetadata = await this.getBookMetadataFromScanData(media.audioFiles, libraryItemData, libraryScan)
    let authorsUpdated = false
    const bookAuthorsRemoved = []
    let seriesUpdated = false
    const bookSeriesRemoved = []

    for (const key in bookMetadata) {
      // Ignore unset metadata and empty arrays
      if (bookMetadata[key] === undefined || (Array.isArray(bookMetadata[key]) && !bookMetadata[key].length)) continue

      if (key === 'authors') {
        // Check for authors added
        for (const authorName of bookMetadata.authors) {
          if (!media.authors.some(au => au.name === authorName)) {
            const existingAuthor = Database.libraryFilterData[libraryScan.libraryId].authors.find(au => au.name === authorName)
            if (existingAuthor) {
              await Database.bookAuthorModel.create({
                bookId: media.id,
                authorId: existingAuthor.id
              })
              libraryScan.addLog(LogLevel.DEBUG, `Updating book "${bookMetadata.title}" added author "${authorName}"`)
              authorsUpdated = true
            } else {
              const newAuthor = await Database.authorModel.create({
                name: authorName,
                lastFirst: parseNameString.nameToLastFirst(authorName),
                libraryId: libraryScan.libraryId
              })
              await media.addAuthor(newAuthor)
              Database.addAuthorToFilterData(libraryScan.libraryId, newAuthor.name, newAuthor.id)
              libraryScan.addLog(LogLevel.DEBUG, `Updating book "${bookMetadata.title}" added new author "${authorName}"`)
              authorsUpdated = true
            }
          }
        }
        // Check for authors removed
        for (const author of media.authors) {
          if (!bookMetadata.authors.includes(author.name)) {
            await author.bookAuthor.destroy()
            libraryScan.addLog(LogLevel.DEBUG, `Updating book "${bookMetadata.title}" removed author "${author.name}"`)
            authorsUpdated = true
            bookAuthorsRemoved.push(author.id)
          }
        }
      } else if (key === 'series') {
        // Check for series added
        for (const seriesObj of bookMetadata.series) {
          if (!media.series.some(se => se.name === seriesObj.name)) {
            const existingSeries = Database.libraryFilterData[libraryScan.libraryId].series.find(se => se.name === seriesObj.name)
            if (existingSeries) {
              await Database.bookSeriesModel.create({
                bookId: media.id,
                seriesId: existingSeries.id,
                sequence: seriesObj.sequence
              })
              libraryScan.addLog(LogLevel.DEBUG, `Updating book "${bookMetadata.title}" added series "${seriesObj.name}"${seriesObj.sequence ? ` with sequence "${seriesObj.sequence}"` : ''}`)
              seriesUpdated = true
            } else {
              const newSeries = await Database.seriesModel.create({
                name: seriesObj.name,
                nameIgnorePrefix: getTitleIgnorePrefix(seriesObj.name),
                libraryId: libraryScan.libraryId
              })
              await media.addSeries(newSeries)
              Database.addSeriesToFilterData(libraryScan.libraryId, newSeries.name, newSeries.id)
              libraryScan.addLog(LogLevel.DEBUG, `Updating book "${bookMetadata.title}" added new series "${seriesObj.name}"${seriesObj.sequence ? ` with sequence "${seriesObj.sequence}"` : ''}`)
              seriesUpdated = true
            }
          }
        }
        // Check for series removed
        for (const series of media.series) {
          if (!bookMetadata.series.some(se => se.name === series.name)) {
            await series.bookSeries.destroy()
            libraryScan.addLog(LogLevel.DEBUG, `Updating book "${bookMetadata.title}" removed series "${series.name}"`)
            seriesUpdated = true
            bookSeriesRemoved.push(series.id)
          }
        }
      } else if (key === 'genres') {
        const existingGenres = media.genres || []
        if (bookMetadata.genres.some(g => !existingGenres.includes(g)) || existingGenres.some(g => !bookMetadata.genres.includes(g))) {
          libraryScan.addLog(LogLevel.DEBUG, `Updating book genres "${existingGenres.join(',')}" => "${bookMetadata.genres.join(',')}" for book "${bookMetadata.title}"`)
          media.genres = bookMetadata.genres
          hasMediaChanges = true
        }
      } else if (key === 'tags') {
        const existingTags = media.tags || []
        if (bookMetadata.tags.some(t => !existingTags.includes(t)) || existingTags.some(t => !bookMetadata.tags.includes(t))) {
          libraryScan.addLog(LogLevel.DEBUG, `Updating book tags "${existingTags.join(',')}" => "${bookMetadata.tags.join(',')}" for book "${bookMetadata.title}"`)
          media.tags = bookMetadata.tags
          hasMediaChanges = true
        }
      } else if (key === 'narrators') {
        const existingNarrators = media.narrators || []
        if (bookMetadata.narrators.some(t => !existingNarrators.includes(t)) || existingNarrators.some(t => !bookMetadata.narrators.includes(t))) {
          libraryScan.addLog(LogLevel.DEBUG, `Updating book narrators "${existingNarrators.join(',')}" => "${bookMetadata.narrators.join(',')}" for book "${bookMetadata.title}"`)
          media.narrators = bookMetadata.narrators
          hasMediaChanges = true
        }
      } else if (key === 'chapters') {
        if (!areEquivalent(media.chapters, bookMetadata.chapters)) {
          libraryScan.addLog(LogLevel.DEBUG, `Updating book chapters for book "${bookMetadata.title}"`)
          media.chapters = bookMetadata.chapters
          hasMediaChanges = true
        }
      } else if (key === 'coverPath') {
        if (media.coverPath && media.coverPath !== bookMetadata.coverPath && !(await fsExtra.pathExists(media.coverPath))) {
          libraryScan.addLog(LogLevel.DEBUG, `Updating book cover "${media.coverPath}" => "${bookMetadata.coverPath}" for book "${bookMetadata.title}" - original cover path does not exist`)
          media.coverPath = bookMetadata.coverPath
          hasMediaChanges = true
        } else if (!media.coverPath) {
          libraryScan.addLog(LogLevel.DEBUG, `Updating book cover "unset" => "${bookMetadata.coverPath}" for book "${bookMetadata.title}"`)
          media.coverPath = bookMetadata.coverPath
          hasMediaChanges = true
        }
      } else if (bookMetadata[key] !== media[key]) {
        libraryScan.addLog(LogLevel.DEBUG, `Updating book ${key} "${media[key]}" => "${bookMetadata[key]}" for book "${bookMetadata.title}"`)
        media[key] = bookMetadata[key]
        hasMediaChanges = true
      }
    }

    // If no cover then extract cover from audio file if available
    if (!media.coverPath && media.audioFiles.length) {
      const libraryItemDir = existingLibraryItem.isFile ? null : existingLibraryItem.path
      const extractedCoverPath = await CoverManager.saveEmbeddedCoverArtNew(media.audioFiles, existingLibraryItem.id, libraryItemDir)
      if (extractedCoverPath) {
        libraryScan.addLog(LogLevel.DEBUG, `Updating book "${bookMetadata.title}" extracted embedded cover art from audio file to path "${extractedCoverPath}"`)
        media.coverPath = extractedCoverPath
        hasMediaChanges = true
      }
    }

    // Save Book changes to db
    if (hasMediaChanges) {
      await media.save()
    }

    // Load authors/series again if updated (for sending back to client)
    if (authorsUpdated) {
      media.authors = await media.getAuthors({
        joinTableAttributes: ['createdAt'],
        order: [
          Sequelize.literal(`bookAuthor.createdAt ASC`)
        ]
      })
    }
    if (seriesUpdated) {
      media.series = await media.getSeries({
        joinTableAttributes: ['sequence', 'createdAt'],
        order: [
          Sequelize.literal(`bookSeries.createdAt ASC`)
        ]
      })
    }

    libraryScan.seriesRemovedFromBooks.push(...bookSeriesRemoved)
    libraryScan.authorsRemovedFromBooks.push(...bookAuthorsRemoved)

    existingLibraryItem.media = media
    return existingLibraryItem
  }

  /**
   * 
   * @param {import('./LibraryItemScanData')} libraryItemData 
   * @param {import('./LibraryScan')} libraryScan 
   * @returns {import('../models/LibraryItem')}
   */
  async scanNewBookLibraryItem(libraryItemData, libraryScan) {
    // Scan audio files found
    let scannedAudioFiles = await AudioFileScanner.executeMediaFileScans(libraryScan.libraryMediaType, libraryItemData, libraryItemData.audioLibraryFiles)
    scannedAudioFiles = AudioFileScanner.runSmartTrackOrder(libraryItemData.relPath, scannedAudioFiles)

    // Find ebook file (prefer epub)
    let ebookLibraryFile = libraryScan.library.settings.audiobooksOnly ? null : libraryItemData.ebookLibraryFiles.find(lf => lf.metadata.ext.slice(1).toLowerCase() === 'epub') || libraryItemData.ebookLibraryFiles[0]

    // Do not add library items that have no valid audio files and no ebook file
    if (!ebookLibraryFile && !scannedAudioFiles.length) {
      libraryScan.addLog(LogLevel.WARN, `Library item at path "${libraryItemData.relPath}" has no audio files and no ebook file - ignoring`)
      return null
    }

    if (ebookLibraryFile) {
      ebookLibraryFile.ebookFormat = ebookLibraryFile.metadata.ext.slice(1).toLowerCase()
    }

    const bookMetadata = await this.getBookMetadataFromScanData(scannedAudioFiles, libraryItemData, libraryScan)
    bookMetadata.explicit = !!bookMetadata.explicit // Ensure boolean
    bookMetadata.abridged = !!bookMetadata.abridged // Ensure boolean

    let duration = 0
    scannedAudioFiles.forEach((af) => duration += (!isNaN(af.duration) ? Number(af.duration) : 0))
    const bookObject = {
      ...bookMetadata,
      audioFiles: scannedAudioFiles,
      ebookFile: ebookLibraryFile || null,
      duration,
      bookAuthors: [],
      bookSeries: []
    }
    if (bookMetadata.authors.length) {
      for (const authorName of bookMetadata.authors) {
        const matchingAuthor = Database.libraryFilterData[libraryScan.libraryId].authors.find(au => au.name === authorName)
        if (matchingAuthor) {
          bookObject.bookAuthors.push({
            authorId: matchingAuthor.id
          })
        } else {
          // New author
          bookObject.bookAuthors.push({
            author: {
              libraryId: libraryScan.libraryId,
              name: authorName,
              lastFirst: parseNameString.nameToLastFirst(authorName)
            }
          })
        }
      }
    }
    if (bookMetadata.series.length) {
      for (const seriesObj of bookMetadata.series) {
        if (!seriesObj.name) continue
        const matchingSeries = Database.libraryFilterData[libraryScan.libraryId].series.find(se => se.name === seriesObj.name)
        if (matchingSeries) {
          bookObject.bookSeries.push({
            seriesId: matchingSeries.id,
            sequence: seriesObj.sequence
          })
        } else {
          bookObject.bookSeries.push({
            sequence: seriesObj.sequence,
            series: {
              name: seriesObj.name,
              nameIgnorePrefix: getTitleIgnorePrefix(seriesObj.name),
              libraryId: libraryScan.libraryId
            }
          })
        }
      }
    }

    const libraryItemObj = libraryItemData.libraryItemObject
    libraryItemObj.id = uuidv4() // Generate library item id ahead of time to use for saving extracted cover image
    libraryItemObj.isMissing = false
    libraryItemObj.isInvalid = false

    // Set isSupplementary flag on ebook library files
    for (const libraryFile of libraryItemObj.libraryFiles) {
      if (globals.SupportedEbookTypes.includes(libraryFile.metadata.ext.slice(1).toLowerCase())) {
        libraryFile.isSupplementary = libraryFile.ino !== ebookLibraryFile?.ino
      }
    }

    // If cover was not found in folder then check embedded covers in audio files
    if (!bookObject.coverPath && scannedAudioFiles.length) {
      const libraryItemDir = libraryItemObj.isFile ? null : libraryItemObj.path
      // Extract and save embedded cover art
      bookObject.coverPath = await CoverManager.saveEmbeddedCoverArtNew(scannedAudioFiles, libraryItemObj.id, libraryItemDir)
    }

    libraryItemObj.book = bookObject
    const libraryItem = await Database.libraryItemModel.create(libraryItemObj, {
      include: {
        model: Database.bookModel,
        include: [
          {
            model: Database.bookSeriesModel,
            include: {
              model: Database.seriesModel
            }
          },
          {
            model: Database.bookAuthorModel,
            include: {
              model: Database.authorModel
            }
          }
        ]
      }
    })

    // Update library filter data
    if (libraryItem.book.bookSeries?.length) {
      for (const bs of libraryItem.book.bookSeries) {
        if (bs.series) {
          Database.addSeriesToFilterData(libraryScan.libraryId, bs.series.name, bs.series.id)
        }
      }
    }
    if (libraryItem.book.bookAuthors?.length) {
      for (const ba of libraryItem.book.bookAuthors) {
        if (ba.author) {
          Database.addAuthorToFilterData(libraryScan.libraryId, ba.author.name, ba.author.id)
        }
      }
    }
    Database.addNarratorsToFilterData(libraryScan.libraryId, libraryItem.book.narrators)
    Database.addGenresToFilterData(libraryScan.libraryId, libraryItem.book.genres)
    Database.addTagsToFilterData(libraryScan.libraryId, libraryItem.book.tags)
    Database.addPublisherToFilterData(libraryScan.libraryId, libraryItem.book.publisher)
    Database.addLanguageToFilterData(libraryScan.libraryId, libraryItem.book.language)

    // Load for emitting to client
    libraryItem.media = await libraryItem.getMedia({
      include: [
        {
          model: Database.authorModel,
          through: {
            attributes: ['id', 'createdAt']
          }
        },
        {
          model: Database.seriesModel,
          through: {
            attributes: ['id', 'sequence', 'createdAt']
          }
        }
      ],
      order: [
        [Database.authorModel, Database.bookAuthorModel, 'createdAt', 'ASC'],
        [Database.seriesModel, 'bookSeries', 'createdAt', 'ASC']
      ]
    })

    return libraryItem
  }

  /**
   * 
   * @param {import('../models/Book').AudioFileObject[]} audioFiles 
   * @param {import('./LibraryItemScanData')} libraryItemData 
   * @param {import('./LibraryScan')} libraryScan 
   * @returns {Promise<BookMetadataObject>}
   */
  async getBookMetadataFromScanData(audioFiles, libraryItemData, libraryScan) {
    // First set book metadata from folder/file names
    const bookMetadata = {
      title: libraryItemData.mediaMetadata.title,
      titleIgnorePrefix: getTitleIgnorePrefix(libraryItemData.mediaMetadata.title),
      subtitle: libraryItemData.mediaMetadata.subtitle || undefined,
      publishedYear: libraryItemData.mediaMetadata.publishedYear || undefined,
      publisher: undefined,
      description: undefined,
      isbn: undefined,
      asin: undefined,
      language: undefined,
      narrators: parseNameString.parse(libraryItemData.mediaMetadata.narrators)?.names || [],
      genres: [],
      tags: [],
      authors: parseNameString.parse(libraryItemData.mediaMetadata.author)?.names || [],
      series: [],
      chapters: [],
      explicit: undefined,
      abridged: undefined,
      coverPath: undefined
    }
    if (libraryItemData.mediaMetadata.series) {
      bookMetadata.series.push({
        name: libraryItemData.mediaMetadata.series,
        sequence: libraryItemData.mediaMetadata.sequence || null
      })
    }

    // Fill in or override book metadata from audio file meta tags
    if (audioFiles.length) {
      const MetadataMapArray = [
        {
          tag: 'tagComposer',
          key: 'narrators'
        },
        {
          tag: 'tagDescription',
          altTag: 'tagComment',
          key: 'description'
        },
        {
          tag: 'tagPublisher',
          key: 'publisher'
        },
        {
          tag: 'tagDate',
          key: 'publishedYear'
        },
        {
          tag: 'tagSubtitle',
          key: 'subtitle'
        },
        {
          tag: 'tagAlbum',
          altTag: 'tagTitle',
          key: 'title',
        },
        {
          tag: 'tagArtist',
          altTag: 'tagAlbumArtist',
          key: 'authors'
        },
        {
          tag: 'tagGenre',
          key: 'genres'
        },
        {
          tag: 'tagSeries',
          key: 'series'
        },
        {
          tag: 'tagIsbn',
          key: 'isbn'
        },
        {
          tag: 'tagLanguage',
          key: 'language'
        },
        {
          tag: 'tagASIN',
          key: 'asin'
        }
      ]
      const overrideExistingDetails = Database.serverSettings.scannerPreferAudioMetadata
      const firstScannedFile = audioFiles[0]
      const audioFileMetaTags = firstScannedFile.metaTags
      MetadataMapArray.forEach((mapping) => {
        let value = audioFileMetaTags[mapping.tag]
        if (!value && mapping.altTag) {
          value = audioFileMetaTags[mapping.altTag]
        }

        if (value && typeof value === 'string') {
          value = value.trim() // Trim whitespace

          if (mapping.key === 'narrators' && (!bookMetadata.narrators.length || overrideExistingDetails)) {
            bookMetadata.narrators = parseNameString.parse(value)?.names || []
          } else if (mapping.key === 'authors' && (!bookMetadata.authors.length || overrideExistingDetails)) {
            bookMetadata.authors = parseNameString.parse(value)?.names || []
          } else if (mapping.key === 'genres' && (!bookMetadata.genres.length || overrideExistingDetails)) {
            bookMetadata.genres = this.parseGenresString(value)
          } else if (mapping.key === 'series' && (!bookMetadata.series.length || overrideExistingDetails)) {
            bookMetadata.series = [
              {
                name: value,
                sequence: audioFileMetaTags.tagSeriesPart || null
              }
            ]
          } else if (!bookMetadata[mapping.key] || overrideExistingDetails) {
            bookMetadata[mapping.key] = value
          }
        }
      })
    }

    // If desc.txt in library item folder then use this for description
    if (libraryItemData.descTxtLibraryFile) {
      const description = await readTextFile(libraryItemData.descTxtLibraryFile.metadata.path)
      if (description.trim()) bookMetadata.description = description.trim()
    }

    // If reader.txt in library item folder then use this for narrator
    if (libraryItemData.readerTxtLibraryFile) {
      let narrator = await readTextFile(libraryItemData.readerTxtLibraryFile.metadata.path)
      narrator = narrator.split(/\r?\n/)[0]?.trim() || '' // Only use first line
      if (narrator) {
        bookMetadata.narrators = parseNameString.parse(narrator)?.names || []
      }
    }

    // If opf file is found look for metadata
    if (libraryItemData.metadataOpfLibraryFile) {
      const xmlText = await readTextFile(libraryItemData.metadataOpfLibraryFile.metadata.path)
      const opfMetadata = xmlText ? await parseOpfMetadataXML(xmlText) : null
      if (opfMetadata) {
        const opfMetadataOverrideDetails = Database.serverSettings.scannerPreferOpfMetadata
        for (const key in opfMetadata) {
          if (key === 'tags') { // Add tags only if tags are empty
            if (opfMetadata.tags.length && (!bookMetadata.tags.length || opfMetadataOverrideDetails)) {
              bookMetadata.tags = opfMetadata.tags
            }
          } else if (key === 'genres') { // Add genres only if genres are empty
            if (opfMetadata.genres.length && (!bookMetadata.genres.length || opfMetadataOverrideDetails)) {
              bookMetadata.genres = opfMetadata.genres
            }
          } else if (key === 'authors') {
            if (opfMetadata.authors?.length && (!bookMetadata.authors.length || opfMetadataOverrideDetails)) {
              bookMetadata.authors = opfMetadata.authors
            }
          } else if (key === 'narrators') {
            if (opfMetadata.narrators?.length && (!bookMetadata.narrators.length || opfMetadataOverrideDetails)) {
              bookMetadata.narrators = opfMetadata.narrators
            }
          } else if (key === 'series') {
            if (opfMetadata.series && (!bookMetadata.series.length || opfMetadataOverrideDetails)) {
              bookMetadata.series = [{
                name: opfMetadata.series,
                sequence: opfMetadata.sequence || null
              }]
            }
          } else if (opfMetadata[key] && (!bookMetadata[key] || opfMetadataOverrideDetails)) {
            bookMetadata[key] = opfMetadata[key]
          }
        }
      }
    }

    // If metadata.json or metadata.abs use this for metadata
    const metadataLibraryFile = libraryItemData.metadataJsonLibraryFile || libraryItemData.metadataAbsLibraryFile
    const metadataText = metadataLibraryFile ? await readTextFile(metadataLibraryFile.metadata.path) : null
    if (metadataText) {
      libraryScan.addLog(LogLevel.INFO, `Found metadata file "${metadataLibraryFile.metadata.relPath}" - preferring`)
      let abMetadata = null
      if (!!libraryItemData.metadataJsonLibraryFile) {
        abMetadata = abmetadataGenerator.parseJson(metadataText)
      } else {
        abMetadata = abmetadataGenerator.parse(metadataText, 'book')
      }

      if (abMetadata) {
        if (abMetadata.tags?.length) {
          bookMetadata.tags = abMetadata.tags
        }
        if (abMetadata.chapters?.length) {
          bookMetadata.chapters = abMetadata.chapters
        }
        for (const key in abMetadata.metadata) {
          if (bookMetadata[key] === undefined || abMetadata.metadata[key] === undefined) continue
          bookMetadata[key] = abMetadata.metadata[key]
        }
      }
    }

    // Set chapters from audio files if not already set
    if (!bookMetadata.chapters.length) {
      bookMetadata.chapters = this.getChaptersFromAudioFiles(bookMetadata.title, audioFiles, libraryScan)
    }

    // Set cover from library file if one is found otherwise check audiofile
    if (libraryItemData.imageLibraryFiles.length) {
      const coverMatch = libraryItemData.imageLibraryFiles.find(iFile => /\/cover\.[^.\/]*$/.test(iFile.metadata.path))
      bookMetadata.coverPath = coverMatch?.metadata.path || libraryItemData.imageLibraryFiles[0].metadata.path
    }

    return bookMetadata
  }

  /**
   * Parse a genre string into multiple genres
   * @example "Fantasy;Sci-Fi;History" => ["Fantasy", "Sci-Fi", "History"]
   * @param {string} genreTag 
   * @returns {string[]}
   */
  parseGenresString(genreTag) {
    if (!genreTag?.length) return []
    const separators = ['/', '//', ';']
    for (let i = 0; i < separators.length; i++) {
      if (genreTag.includes(separators[i])) {
        return genreTag.split(separators[i]).map(genre => genre.trim()).filter(g => !!g)
      }
    }
    return [genreTag]
  }

  /**
   * @param {string} bookTitle
   * @param {AudioFile[]} audioFiles 
   * @param {import('./LibraryScan')} libraryScan
   * @returns {import('../models/Book').ChapterObject[]}
   */
  getChaptersFromAudioFiles(bookTitle, audioFiles, libraryScan) {
    if (!audioFiles.length) return []

    // If overdrive media markers are present and preferred, use those instead
    if (Database.serverSettings.scannerPreferOverdriveMediaMarker) {
      const overdriveChapters = parseOverdriveMediaMarkersAsChapters(audioFiles)
      if (overdriveChapters) {
        libraryScan.addLog(LogLevel.DEBUG, 'Overdrive Media Markers and preference found! Using these for chapter definitions')

        return overdriveChapters
      }
    }

    let chapters = []

    // If first audio file has embedded chapters then use embedded chapters
    if (audioFiles[0].chapters?.length) {
      // If all files chapters are the same, then only make chapters for the first file
      if (
        audioFiles.length === 1 ||
        audioFiles.length > 1 &&
        audioFiles[0].chapters.length === audioFiles[1].chapters?.length &&
        audioFiles[0].chapters.every((c, i) => c.title === audioFiles[1].chapters[i].title)
      ) {
        libraryScan.addLog(LogLevel.DEBUG, `setChapters: Using embedded chapters in first audio file ${audioFiles[0].metadata?.path}`)
        chapters = audioFiles[0].chapters.map((c) => ({ ...c }))
      } else {
        libraryScan.addLog(LogLevel.DEBUG, `setChapters: Using embedded chapters from all audio files ${audioFiles[0].metadata?.path}`)
        let currChapterId = 0
        let currStartTime = 0

        audioFiles.forEach((file) => {
          if (file.duration) {
            const afChapters = file.chapters?.map((c) => ({
              ...c,
              id: c.id + currChapterId,
              start: c.start + currStartTime,
              end: c.end + currStartTime,
            })) ?? []
            chapters = chapters.concat(afChapters)

            currChapterId += file.chapters?.length ?? 0
            currStartTime += file.duration
          }
        })
        return chapters
      }
    } else if (audioFiles.length > 1) {
      const preferAudioMetadata = !!Database.serverSettings.scannerPreferAudioMetadata

      // Build chapters from audio files
      let currChapterId = 0
      let currStartTime = 0
      includedAudioFiles.forEach((file) => {
        if (file.duration) {
          let title = file.metadata.filename ? Path.basename(file.metadata.filename, Path.extname(file.metadata.filename)) : `Chapter ${currChapterId}`

          // When prefer audio metadata server setting is set then use ID3 title tag as long as it is not the same as the book title
          if (preferAudioMetadata && file.metaTags?.tagTitle && file.metaTags?.tagTitle !== bookTitle) {
            title = file.metaTags.tagTitle
          }

          chapters.push({
            id: currChapterId++,
            start: currStartTime,
            end: currStartTime + file.duration,
            title
          })
          currStartTime += file.duration
        }
      })
    }
    return chapters
  }
}
module.exports = new BookScanner()