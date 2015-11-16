/* based on: https://github.com/adobe/brackets/blob/master/src/extensions/default/JavaScriptQuickEdit/main.js */

define(function (require, exports, module) {
    
    'use strict';
    
    // Brackets modules
    
    var MultiRangeInlineEditor  = brackets.getModule("editor/MultiRangeInlineEditor").MultiRangeInlineEditor,
        EditorManager           = brackets.getModule('editor/EditorManager'),
        DocumentManager         = brackets.getModule("document/DocumentManager"),
        SOYUtils                = require("SOYUtils"),
        LanguageManager         = brackets.getModule('language/LanguageManager'),
        ProjectManager          = brackets.getModule('project/ProjectManager');
    
    var _templateRegExp         = /{template ([^\}\/][^\s]+)/g;
    
    /** Return an object with the name of the template which was called
     *  at the current cursor position.
     */

    function _getTemplateName(hostEditor, pos) { 
        var fn_begin = 0,
            blackList = "/} ",
            templateName = "",
            namespaceName, tokenArray, i;
        
            DocumentManager.getDocumentForPath(hostEditor.document.file.fullPath)
            .done(function (doc) {
                 var text         = doc.getText(),
                 _namespaceRegExp = /{namespace ([^\}\/][^\s]+)(?:\})/g;
                 
                 if ((namespaceName = _namespaceRegExp.exec(text)) !== null) {
                    namespaceName = namespaceName[1].trim();
                 }
             
                 return namespaceName;
            })
            .fail(function (error) {
            });
               
            tokenArray = hostEditor._codeMirror.getLineTokens(pos.line, true);

            for (i = 0; i < tokenArray.length; i++){
                if (fn_begin === 0 && tokenArray[i].string === "{call" && tokenArray[i].type === "keyword") {
                    fn_begin = i + 2;
                }

                if (fn_begin > 0 && fn_begin <= i) {
                    if (blackList.indexOf(tokenArray[i].string) === -1){
                        templateName += tokenArray[i].string;
                    } else {
                        break;
                    }
                }
            }
            if(templateName.substr(0,1) === "."){
                templateName = namespaceName + templateName;
            }
        
         return {
             templateName: templateName,
             reason: null
         };
    }
    
    
    /** Find the template definition in the opened project
     *  for creating inline editor.
     */ 
    function _findInProject(templateName) {
        var result = new $.Deferred();
        
        function _nonBinaryFileFilter(file) {
            return !LanguageManager.getLanguageForPath(file.fullPath).isBinary();
        }
        
        ProjectManager.getAllFiles(_nonBinaryFileFilter)
            .done(function (files) {
                SOYUtils.findMatchingTemplates(templateName, files)
                    .done(function (templates) {
                        result.resolve(templates);
                    })
                    .fail(function () {
                        result.reject();
                    });
            })
            .fail(function () {
                result.reject();
            });
        
        return result.promise();
    }
    
     /** Creating inline editor if we've got the appropriate template
     */    
    function _createInlineEditor(hostEditor, templateName) {
        var result = new $.Deferred();
        
        _findInProject(templateName).done(function (templates) {
            if (templates && templates.length > 0) {
                var soyInlineEditor = new MultiRangeInlineEditor(templates);
                soyInlineEditor.load(hostEditor);
                result.resolve(soyInlineEditor);
            } else {
                // No matching templates were found
                result.reject();
            }
        }).fail(function () {
            result.reject();
        });

        return result.promise();
    }
  
    
    function provider(hostEditor, pos) {
        // Only provide an editor when cursor is in SOY content
        if (hostEditor.getModeForSelection() !== "soy") {
            return null;
         }
         
        var sel = hostEditor.getSelection();
        // Only provide an editor if the selection is within a single line
        if (sel.start.line !== sel.end.line) {
            return null;
        }
     
      var functionResult = _getTemplateName(hostEditor, sel.start);
     
        if (!functionResult.templateName) {
            return functionResult.reason || null;
        }

        return _createInlineEditor(hostEditor, functionResult.templateName);
  }

    LanguageManager.defineLanguage('soy', {
        name: 'Soy',
        mode: 'soy',
        fileExtensions: ['soy'],
        blockComment: ['/*', '*/'],
        lineComment: ['//']
    });
    
    EditorManager.registerInlineEditProvider(provider);
});