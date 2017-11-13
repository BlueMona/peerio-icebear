const { observable, action } = require('mobx');
const { getUser } = require('../../helpers/di-current-user');
const socket = require('../../network/socket');
const FileFolder = require('./file-folder');
const FileFoldersKeg = require('./file-folders-keg');
const cryptoUtil = require('../../crypto/util');
const warnings = require('../warnings');

class FileFolders {
    constructor(fileStore) {
        this.fileStore = fileStore;
        socket.onceAuthenticated(() => {
            this.keg = new FileFoldersKeg(getUser().kegDb);
            this.keg.onUpdated = () => {
                console.log(`file folders updated`);
                this.sync();
            };
        });
    }
    @observable initialized;
    @observable keg = null;

    get loaded() { return this.keg && this.keg.loaded; }

    get formatVersion() { return this.keg.formatVersion; }

    root = new FileFolder('/');

    folderResolveMap = {};

    getById(id) {
        return this.folderResolveMap[id];
    }

    _addFile = (file) => {
        const { root } = this;
        const folderToResolve = this.getById(file.folderId);
        if (file.folder && file.folder === folderToResolve) return;
        if (folderToResolve) {
            file.folder && file.folder.free(file);
            folderToResolve.add(file);
        } else {
            !file.folder && root.add(file);
        }
    }

    @action async sync() {
        if (!this.keg.formatVersion) {
            this.createDefault();
            await this.keg.saveToServer();
        }
        const { files } = this.fileStore;
        if (this._intercept) {
            this._intercept();
            this._intercept = null;
        }
        const { folderResolveMap, root } = this;
        const newFolderResolveMap = {};
        root.deserialize(this.keg, null, folderResolveMap, newFolderResolveMap);
        // remove files from folders if they aren't present in the keg
        files.forEach(f => {
            if (f.folderId) {
                const folder = this.getById(f.folderId);
                if (folder) folder.moveInto(f);
            } else if (f.folder) f.folder.free(f);
        });
        // remove folders if they aren't present in the keg
        for (const folderId in folderResolveMap) {
            if (!newFolderResolveMap[folderId]) {
                folderResolveMap[folderId].freeSelf();
            }
        }
        this.folderResolveMap = newFolderResolveMap;
        this.folderResolveMapSorted = Object.values(this.folderResolveMap)
            .sort((f1, f2) => f1.normalizedName > f2.normalizedName);
        files.forEach(this._addFile);
        this._intercept = files.observe(delta => {
            delta.removed.forEach(file => {
                if (file.folder) file.folder.free(file);
            });
            delta.added.forEach(this._addFile);
            return delta;
        });
        console.log('file-folders: step 3');
        this.initialized = true;
    }

    searchAllFoldersNyName(name) {
        const q = name ? name.toLowerCase() : '';
        return this.folderResolveMapSorted
            .filter(f => f.normalizedName.includes(q));
    }

    createDefault() {
        this.keg.formatVersion = '1.0';
    }

    deleteFolder(folder) {
        folder.freeSelf();
        this.save();
    }

    createFolder(name, parent) {
        const target = parent || this.root;
        if (target.findFolderByName(name)) {
            warnings.addSevere('error_folderAlreadyExists');
            throw new Error('error_folderAlreadyExists');
        }
        const folder = new FileFolder(name);
        const folderId = cryptoUtil.getRandomUserSpecificIdB64(getUser().username);
        folder.folderId = folderId;
        folder.createdAt = new Date();
        this.folderResolveMap[folderId] = folder;
        target.addFolder(folder);
        return folder;
    }

    save() {
        this.keg.save(() => {
            this.keg.folders = this.root.folders.map(f => f.serialize());
        }, () => this.sync(), 'error_savingFileFolders');
    }
}

module.exports = FileFolders;