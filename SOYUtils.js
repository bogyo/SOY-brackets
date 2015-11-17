/* based on: https://github.com/adobe/brackets/blob/master/src/language/JSUtils.js */

define(function (require, exports, module) {
    
    'use strict';
    
    var _ = brackets.getModule("thirdparty/lodash");
    
    // Load brackets modules
    var CodeMirror              = brackets.getModule("thirdparty/CodeMirror/lib/codemirror"),
        Async                   = brackets.getModule("utils/Async"),
        DocumentManager         = brackets.getModule("document/DocumentManager"),
        ChangedDocumentTracker  = brackets.getModule("document/ChangedDocumentTracker"),
        FileSystem              = brackets.getModule("filesystem/FileSystem"),
        FileUtils               = brackets.getModule("file/FileUtils"),
        StringUtils             = brackets.getModule("utils/StringUtils");

    /**
     * Tracks dirty documents between invocations of findMatchingTemplates.
     * @type {ChangedDocumentTracker}
     */
    var _changedDocumentTracker = new ChangedDocumentTracker();
    
    /**
     * Template matching regular expression. Recognizes the forms:
     * "{template templateName ".
     *
     */
    
    
    var _templateRegExp = /{template ([^\}\/][^\s^\}\/]+)/g;
    
    /**
     * @private
     * Return an object mapping template name to offset info for all templates in the specified text.
     * @param {!string} text Document text
     * @return {Object.<string, Array.<{offsetStart: number, offsetEnd: number}>}
     */
    function  _findAllTemplatesInText(text) {
        var results = {},
            namespaceName,
            templateName,
            match,
            _namespaceRegExp = /{namespace ([^\}\/][^\s]+)(?:\})/g;
        
       if ((namespaceName = _namespaceRegExp.exec(text)) !== null) {
            namespaceName = namespaceName[1].trim();
       }
       
            while ((match = _templateRegExp.exec(text)) !== null) {
                templateName = namespaceName + (match[1]).trim();
                
                
                if (!Array.isArray(results[templateName])) {
                    results[templateName] = [];
                }
                
                results[templateName].push({offsetStart: match.index});
            }
    
        return results;
    }
    
    // Given the start offset of a template definition (before the opening brace), find
    // the end offset for the template (the closing "{/template"). 
    
    function _getTemplateEndOffset(text, offsetStart) {
        var mode = CodeMirror.getMode({}, "soy");
        var state = CodeMirror.startState(mode), stream, style, token;
        var curOffset = offsetStart, length = text.length, blockCount = 0, lineStart;
        var foundStartBrace = false;
        

        // Get a stream for the next line, and update curOffset and lineStart to point to the 
        // beginning of that next line. Returns false if we're at the end of the text.
                     
        function nextLine() {
            if (stream) {
                curOffset++; // account for \n
                if (curOffset >= length) {
                    return false;
                }
            }
            lineStart = curOffset;
            var lineEnd = text.indexOf("\n", lineStart);
            
            if (lineEnd === -1) {
                lineEnd = length;
            }
            stream = new CodeMirror.StringStream(text.slice(curOffset, lineEnd));
            return true;
        }
        
        // Get the next token, updating the style and token to refer to the current
        // token, and updating the curOffset to point to the end of the token (relative
        // to the start of the original text).
        function nextToken() {
            if (curOffset >= length) {
                return false;
            }
            if (stream) {
                // Set the start of the next token to the current stream position.
                stream.start = stream.pos;
            }
            while (!stream || stream.eol()) {
                if (!nextLine()) {
                    return false;
                }
            }
            style = mode.token(stream, state);
            token = stream.current();
            curOffset = lineStart + stream.pos;
            return true;
        }

        while (nextToken()) {
            if (style === "keyword" && token === "{/template"){
                 return curOffset;
            }
         }
        // Shouldn't get here, but if we do, return the end of the text as the offset.
        return length;
    }

    /**
     * @private
     * Computes template offsetEnd, lineStart and lineEnd. Appends a result record to rangeResults.
     * @param {!Document} doc
     * @param {!string} templateName
     * @param {!Array.<{offsetStart: number, offsetEnd: number}>} templates
     * @param {!Array.<{document: Document, name: string, lineStart: number, lineEnd: number}>} rangeResults
     */
    function _computeOffsets(doc, templateName, templates, rangeResults) {
        var text    = doc.getText(),
            lines   = StringUtils.getLines(text);
        
        
        templates.forEach(function (tmplEntry) {
            if (!tmplEntry.offsetEnd) {
                tmplEntry.offsetEnd = _getTemplateEndOffset(text, tmplEntry.offsetStart);
                tmplEntry.lineStart = StringUtils.offsetToLineNum(lines, tmplEntry.offsetStart);
                tmplEntry.lineEnd   = StringUtils.offsetToLineNum(lines, tmplEntry.offsetEnd);
            }
            
            rangeResults.push({
                document:   doc,
                name:       templateName,
                lineStart:  tmplEntry.lineStart,
                lineEnd:    tmplEntry.lineEnd
            });
    
        });
    }
    
    /**
     * @private
     * Read a file and build a function list. Result is cached in fileInfo.
     * @param {!FileInfo} fileInfo File to parse
     * @param {!$.Deferred} result Deferred to resolve with all templates found and the document
     */
    function _readFile(fileInfo, result) {
        DocumentManager.getDocumentForPath(fileInfo.fullPath)
            .done(function (doc) {
                var allTemplates =  _findAllTemplatesInText(doc.getText());
                
                // Cache the result in the fileInfo object
                fileInfo.SOYUtils = {};
                fileInfo.SOYUtils.functions = allTemplates;
                fileInfo.SOYUtils.timestamp = doc.diskTimestamp;
                
                result.resolve({doc: doc, functions: allTemplates});
            })
            .fail(function (error) {
                result.reject(error);
            });
    }
    
    /**
     * Determines if the document template cache is up to date. 
     * @param {FileInfo} fileInfo
     * @return {$.Promise} A promise resolved with true with true when a template cache is available for the document. Resolves
     * with false when there is no cache or the cache is stale.
     */
    function _shouldGetFromCache(fileInfo) {
        var result = new $.Deferred(),
            isChanged = _changedDocumentTracker.isPathChanged(fileInfo.fullPath);
        
        if (isChanged && fileInfo.SOYUtils) {
            // See if it's dirty and in the working set first
            var doc = DocumentManager.getOpenDocumentForPath(fileInfo.fullPath);
            
            if (doc && doc.isDirty) {
                result.resolve(false);
            } else {
                // If a cache exists, check the timestamp on disk
                var file = FileSystem.getFileForPath(fileInfo.fullPath);
                
                file.stat(function (err, stat) {
                    if (!err) {
                        result.resolve(fileInfo.SOYUtils.timestamp.getTime() === stat.mtime.getTime());
                    } else {
                        result.reject(err);
                    }
                });
            }
        } else {
            // Use the cache if the file did not change and the cache exists
            result.resolve(!isChanged && fileInfo.SOYUtils);
        }

        return result.promise();
    }
    
    /**
     * @private
     * Compute lineStart and lineEnd for each matched template
     * @param {!Array.<{doc: Document, fileInfo: FileInfo, functions: Array.<offsetStart: number, offsetEnd: number>}>} docEntries
     * @param {!string} templateName
     * @param {!Array.<document: Document, name: string, lineStart: number, lineEnd: number>} rangeResults
     * @return {$.Promise} A promise resolved with an array of document ranges to populate a MultiRangeInlineEditor.
     */
    function _getOffsetsForTemplate(docEntries, templateName) {
        // Filter for documents that contain the named function
        var result              = new $.Deferred(),
            matchedDocuments    = [],
            rangeResults        = [];
        
        docEntries.forEach(function (docEntry) {
            // Need to call _.has here since docEntry.functions could have an
            // entry for "hasOwnProperty", which results in an error if trying
            // to invoke docEntry.functions.hasOwnProperty().
            if (_.has(docEntry.functions, templateName)) {
                var templatesInDocument = docEntry.functions[templateName];
                matchedDocuments.push({doc: docEntry.doc, fileInfo: docEntry.fileInfo, functions: templatesInDocument});
            }
        });
        
        Async.doInParallel(matchedDocuments, function (docEntry) {
            var doc         = docEntry.doc,
                oneResult   = new $.Deferred();
            // doc will be undefined if we hit the cache
            if (!doc) {
                DocumentManager.getDocumentForPath(docEntry.fileInfo.fullPath)
                    .done(function (fetchedDoc) {
                        _computeOffsets(fetchedDoc, templateName, docEntry.functions, rangeResults);
                    })
                    .always(function () {
                        oneResult.resolve();
                    });
            } else {
                _computeOffsets(doc, templateName, docEntry.functions, rangeResults);
                oneResult.resolve();
            }
            
            return oneResult.promise();
        }).done(function () {
            result.resolve(rangeResults);
        });
        
        return result.promise();
    }
    
    /**
     * Resolves with a record containing the Document or FileInfo and an Array of all
     * template names with offsets for the specified file. Results may be cached.
     * @param {FileInfo} fileInfo
     * @return {$.Promise} A promise resolved with a document info object that
     *   contains a map of all template names from the document and each templates's start offset. 
     */
    function _getTemplatesForFile(fileInfo) {
        var result = new $.Deferred();
            
        _shouldGetFromCache(fileInfo)
            .done(function (useCache) {
                if (useCache) {
                    // Return cached data. doc property is undefined since we hit the cache.
                    // _getOffsets() will fetch the Document if necessary.
                    result.resolve({/*doc: undefined,*/fileInfo: fileInfo, functions: fileInfo.SOYUtils.functions});
                } else {
                    _readFile(fileInfo, result);
                }
            }).fail(function (err) {
                result.reject(err);
            });
        
        return result.promise();
    }
    
    /**
     * @private
     * Get all templatess for each FileInfo.
     * @param {Array.<FileInfo>} fileInfos
     * @return {$.Promise} A promise resolved with an array of document info objects that each
     *   contain a map of all template names from the document and each template's start offset.
     */
    function _getTemplatesInFiles(fileInfos) {
        var result      = new $.Deferred(),
            docEntries  = [];
        
        Async.doInParallel(fileInfos, function (fileInfo) {
            var oneResult = new $.Deferred();
            
            _getTemplatesForFile(fileInfo)
                .done(function (docInfo) {
                    docEntries.push(docInfo);
                })
                .always(function (error) {
                    // If one file fails, continue to search
                    oneResult.resolve();
                });
            
            return oneResult.promise();
        }).always(function () {
            // Reset ChangedDocumentTracker now that the cache is up to date.
            _changedDocumentTracker.reset();
            
            result.resolve(docEntries);
        });
        
        return result.promise();
    }
    
    /**
     * Return all templates that have the specified name, searching across all the given files.
     *
     * @param {!String} templateName The name to match.
     * @param {!Array.<File>} fileInfos The array of files to search.
     * @return {$.Promise} that will be resolved with an Array of objects containing the
     *      source document, start line, and end line (0-based, inclusive range) for each matching template list.
     */
    function findMatchingTemplates(templateName, fileInfos, keepAllFiles) {
        var result  = new $.Deferred(),
            soyFiles = [];
        
        if (!keepAllFiles) {
            // Filter fileInfos for .js files
            soyFiles = fileInfos.filter(function (fileInfo) {
                return FileUtils.getFileExtension(fileInfo.fullPath).toLowerCase() === "soy";
            });
        } else {
            soyFiles = fileInfos;
        }
        // RegExp search (or cache lookup) for all templates in the project
        _getTemplatesInFiles(soyFiles).done(function (docEntries) {
            // Compute offsets for all matched templates
            _getOffsetsForTemplate(docEntries, templateName).done(function (rangeResults) {
                result.resolve(rangeResults);
            });
        });
        
        return result.promise();
    }

    /**
     * Finds all instances of the specified searchName in "text".
     * Returns an Array of Objects with start and end properties.
     *
     * @param text {!String} SOY text to search
     * @param searchName {!String} template name to search for
     * @return {Array.<{offset:number, templateName:string}>}
     *      Array of objects containing the start offset for each matched templates name.
     */
    function findAllMatchingTemplatesInText(text, searchName) {
        var allTemplates =  _findAllTemplatesInText(text);
        var result = [];
        var lines = text.split("\n");
        
        _.forEach(allTemplates, function (templates, templateName) {
            if (templateName === searchName || searchName === "*") {
                templates.forEach(function (tmplEntry) {
                    var endOffset = _getTemplateEndOffset(text, tmplEntry.offsetStart);
                    result.push({
                        name: templateName,
                        lineStart: StringUtils.offsetToLineNum(lines, tmplEntry.offsetStart),
                        lineEnd: StringUtils.offsetToLineNum(lines, endOffset)
                    });
                });
            }
        });
         
        return result;
    }
    
    exports.findAllMatchingTemplatesInText = findAllMatchingTemplatesInText;
    exports.findMatchingTemplates = findMatchingTemplates;
});