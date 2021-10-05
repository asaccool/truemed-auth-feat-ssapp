import interpretGS1scan from "../utils/interpretGS1scan/interpretGS1scan.js";
import tm from "../../tm.js";
const {WebcController} = WebCardinal.controllers;
const {constants, THREE, PLCameraConfig} = window.Native.Camera;

const api = "https://api-test.truemed.cloud/v1.0";
const apiKey = "3efa4044-3638-4c97-8c57-d94f4ad7ba3d";
const installId = "MTda17VfnVpZdrtPEun66aRYX5C2hT3qoYvhYJDbCaNxSjNxKiMoSG6CP2isWuooTbyh6AyD9B2J3vryV1";

class AuthFeatureError {
    code = 0;
    message = undefined;

    constructor(error){
        if (typeof error === 'string'){
            this.code = 1;
            this.message = error;
        } else {
            this.code = error.code;
            this.message = error.message;
        }
    }
}

class AuthFeatureResponse  {
    status = false;
    error = undefined;

    constructor(status, error) {
        this.status = status;
        this.error = error ? new AuthFeatureError(error) : undefined;
    }
}

/**
 * https://stackoverflow.com/questions/901115/how-can-i-get-query-string-values-in-javascript
 * @param query
 * @returns {*}
 */
const getQueryStringParams = () => {

    const parseQuery = function(query){
        return query.split("?").slice(1).join('?')
    }

    const query = parseQuery(window.frameElement.src);
    return query
        ? (/^[?#]/.test(query) ? query.slice(1) : query)
            .split('&')
            .reduce((params, param) => {
                    let [key, value] = param.split('=');
                    params[key] = value ? decodeURIComponent(value.replace(/\+/g, ' ')) : '';
                    return params;
                }, {}
            )
        : {}
};

const getProductInfo = function(gtin, callback){
    const gtinResolver = require('gtin-resolver');
    const keySSI = gtinResolver.createGTIN_SSI('epi', 'epi', gtin);
    const resolver = require('opendsu').loadApi('resolver');
    resolver.loadDSU(keySSI, (err, dsu) => {
        if (err)
            return callback(err);
        dsu.readFile('product/product.json', (err, product) => {
            if (err)
                return callback(err);
            try{
                product = JSON.parse(product);
            } catch (e) {
                return callback(e);
            }
            callback(undefined, product);
        });
    })
}

const getBatchInfo = function(gtin, batchNumber,  callback){
    const gtinResolver = require('gtin-resolver');
    const keySSI = gtinResolver.createGTIN_SSI('epi', 'epi', gtin, batchNumber);
    const resolver = require('opendsu').loadApi('resolver');
    resolver.loadDSU(keySSI, (err, dsu) => {
        if (err)
            return callback(err);
        dsu.readFile('batch/batch.json', (err, batch) => {
            if (err)
                return callback(err);
            try{
                batch = JSON.parse(batch);
            } catch (e) {
                return callback(e);
            }
            callback(undefined, batch);
        });
    })
}

function compareY (a, b) {
    if (a.y < b.y) {
        return -1;
    }
    if (a.y > b.y) {
        return 1;
    }
    return 0;
}
  
function compareX (a, b) {
    if (a.x < b.x) {
        return -1;
    }
    if (a.x > b.x) {
        return 1;
    }
    return 0;
}

function dataURLtoFile(dataurl, filename) {
    var arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
        bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, {type: mime});
}

export default class HomeController extends WebcController{
    elements = {};
    takenPictures = [];
    cropPictures = [];
    images = [];
    files = [];
    ticketNumber = null;
    tooltipTarget = "Point the camera at the target";
    tooltipMarker = "Align the reticle with the marker";
    tooltipSteady = "Keep the camera steady";
    tooltipLevel = "Keep the phone leveled";
    tooltipCloser = "Move camera closer to target";
    tooltipFurther = "Move camera further from target";
    tooltipStraight = "Make sure the item is straight"

    constructor(element, history, ...args) {
        super(element, history, ...args);
        // Initiating core
        const gs1Data = getQueryStringParams();
        this.model.gs1Data = gs1Data;
        const self = this;
        
        // Initiating TrueMed related
        this.takingPicture = false;
        this.callback = null;
        this.targetMarker = null;
        this.targetHeight = 47;
        this.targetWidth = 45;
        this.targetX = 50;
        this.targetY = 50;
        this.targetError = false;
        this.reticleError = false;
        this.x = 0;
        this.y = 0;
        this.progress = 0;
        this.imageIndex = 0;
        this.centerPos = 0.5;
        this.centerMove = 0.12;
        this.centerOffsets = [
            {x: 0, y: 0},
            {x: 1, y: -1},
            {x: 1, y: 1},
            {x: -1, y: 1},
            {x: -1, y: -1}
        ];
        this.topBotRatio = 1;
        this.leftRightRatio = 1;
        this.pauseProcessing = false;


        this.onTagClick('send', () => {
            this.sendForAnalysis();
        })


        console.log(gs1Data);

        // Retrieve product based on code
        getProductInfo(gs1Data.gtin, (err, product) => {
            if (err)
                console.log(`Could not read product info`, err);
            else
                self.model.product = product;
            getBatchInfo(gs1Data.gtin, gs1Data.batchNumber, (err, batch) => {
                if (err)
                    console.log(`Could not read batch data`, err);
                else
                    self.model.batch = batch;
            });
        });

        // Camera related inits
        this.Camera = window.Native.Camera;
        this.Camera.registerHandlers(
            this.onFramePreview.bind(this),
            this.onFrameGrabbed.bind(this),
            this.onPictureTaken.bind(this)
        )
        this.elements.cameraPreview = this.element.querySelector('#camera-preview');
        this.elements.canvas = this.element.querySelector('#cvCanvas');

        // UI related inits
        this.elements.spiritBarHorizontal = this.element.querySelector('#spirit-bar-horizontal');
        this.elements.spiritBarVertical = this.element.querySelector('#spirit-bar-vertical');
        this.elements.spiritHorizontal = this.element.querySelector('#spirit-horizontal');
        this.elements.spiritVertical = this.element.querySelector('#spirit-vertical');
        
        this.elements.targetBox = this.element.querySelector('#box');
        this.elements.targetBoxImg = this.element.querySelector('#box-img');
        
        this.elements.target = this.element.querySelector('#target-marker');
        this.elements.target.style.opacity = 0;

        this.elements.progressCircle = this.element.querySelector('.progress-ring__circle');
        var radius = this.elements.progressCircle.r.baseVal.value;
        this.circumference = radius * 2 * Math.PI;

        this.elements.progressCircle.style.strokeDasharray = `${this.circumference} ${this.circumference}`;
        this.elements.progressCircle.style.strokeDashoffset = `${this.circumference}`;
        
        for(let i = 1; i < 6; i++){
            let selector = '#taken-picture-'+i;
            this.takenPictures.push(this.element.querySelector(selector));
        }

        for(let i = 1; i < 6; i++){
            let selector = '#crop-picture-'+i;
            this.cropPictures.push(this.element.querySelector(selector));
        }
        
        this.elements.cropView = this.element.querySelector('#crop-view');
        this.elements.sendBtn = this.element.querySelector('#send-btn');
        this.elements.appLoader = this.element.querySelector('#app-boot-loader');
        this.elements.uploadView = this.element.querySelector('#upload-view');
        this.elements.uploadMessage = this.element.querySelector('#upload-message');
        this.elements.tooltip = this.element.querySelector('#tooltip-text');

        let config = new PLCameraConfig("photo",
            "torch", true, false,
            ["wideAngleCamera"], "back",
            true, null,
            1);
        config.initOrientation = "portrait";
        this.getCode("1234");

        this.Camera.nativeBridge.startNativeCameraWithConfig(
            config,
            this.onFramePreview.bind(this),
            25,
            360,
            this.onFrameGrabbed.bind(this),
            10,
            () => {
                console.log("Camera on, hiding loader.");
                this.elements.appLoader.style.display = "none";
                
            },
            0,
            0,
            0,
            0,
            false);
        
    }

    setProduct(packageHeight, packageWidth){
        //let packageWidth = 174;//78;
        //let packageHeight = 50;//58;

        let scaleModifier = 0.6;

        //Physically the package will be flipped 90 degrees while scanning, so we use flipped values
        this.targetHeight = packageWidth * 0.602 * scaleModifier; // 47/78 =
        this.targetWidth = packageHeight * 0.776 * scaleModifier;//45; // 45/58=

        //let canvasHeight = this.elements.canvas.clientHeight;
        //let canvasWidth = this.elements.canvas.clientWidth;

        // Funnily enough, for the box we need the opposite, because we rotate it in CSS
        let targetBoxWidth = packageWidth * 0.776 * scaleModifier;
        let targetBoxHeight = packageHeight * 0.602 * scaleModifier;

        this.elements.targetBox.style.width =  targetBoxWidth + "%";
        this.elements.targetBox.style.height = targetBoxHeight + "%";
    }

    onFrameGrabbed(plImage, elapsedTime){

    }

    placeUint8RGBArrayInCanvas(canvasElem, array, w, h) {
        let a = 1;
        let b = 0;
        canvasElem.width = w;
        canvasElem.height = h*3/4; //NOTE: This might be incorrect. However, it does seem like the output height does not match reality, this helps compensate.
        const ctx = canvasElem.getContext('2d');
        const clampedArray = new Uint8ClampedArray(w*h*4);
        let j = 0
        for (let i = 0; i < 3*w*h; i+=3) {
            clampedArray[j] = b+a*array[i];
            clampedArray[j+1] = b+a*array[i+1];
            clampedArray[j+2] = b+a*array[i+2];
            clampedArray[j+3] = 255;
            j += 4;
        }
        const imageData = new ImageData(clampedArray, w, h);
        ctx.putImageData(imageData, 0, 0);
    }

    onFramePreview(rgbImage, elapsedTime) {
        this.placeUint8RGBArrayInCanvas(this.elements.canvas, new Uint8Array(rgbImage.arrayBuffer), rgbImage.width, rgbImage.height);

        let context = this.elements.canvas.getContext("2d");
        let imgData = context.getImageData(0, 0, this.elements.canvas.width, this.elements.canvas.height);
        
        if(!this.pauseProcessing){
            // Then, construct a cv.Mat:
            let src = cv.matFromImageData(imgData);
            var size = new cv.Size(src.cols, src.rows);
    
            // Apply edges
            // let edges = tm.getMergedEdges(src)
            let edges = tm.getEdges(src);
            
            // Apply contours
            let contours = tm.getContoursForEdges(edges);

            // Clean memory
            src.delete();
            edges.delete();

            // Find largest shapes if any discovered
            if (contours.size() > 0) {
                let bounds = new cv.Rect(5, 5, size.width - 5, size.height - 5);
                let verticalBounds = true;
                let horizontalBounds = true;
                let largestContours = tm.getLargestContourIDs(contours, bounds, verticalBounds, horizontalBounds);
                let contourArray = [contours.get(largestContours[0]), contours.get(largestContours[1])];
        
                // Create frame data, this provides all information for analysis
                var frame = new tm.FrameData(contourArray, size);
        
                // If we found large contours
                if (largestContours.length > 0) {
                    // Size of box
                    let rect = cv.minAreaRect(contours.get(largestContours[0]));
                    let boundingRect = cv.RotatedRect.boundingRect(rect);
        
                    let relativeBoxWidth = boundingRect.width / size.width * 100;
                    let relativeBoxHeight = boundingRect.height / size.height * 100;
        
                    // Coarse check is used to establish if we should display the target marker and assume the user has found a box
                    let coarseBoxSizeErrorMargin = 20;
                    let coarseSizeOK = relativeBoxWidth > this.targetWidth - coarseBoxSizeErrorMargin &&
                                    relativeBoxWidth < this.targetWidth + coarseBoxSizeErrorMargin &&
                                    relativeBoxHeight > this.targetHeight - coarseBoxSizeErrorMargin &&
                                    relativeBoxHeight < this.targetHeight + coarseBoxSizeErrorMargin;
        
                    if (coarseSizeOK) {
                        this.elements.target.style.opacity = 1;
                        this.setTooltip(this.tooltipMarker);
                    } else {
                        this.elements.target.style.opacity = 0;
                        this.setTooltip(this.tooltipTarget);
                    }
        
                    // More strict size check, this limits when phone will actually be allowed to take a picture
                    let boxSizeErrorMargin = 7


                    let sizeOK = relativeBoxWidth > this.targetWidth - boxSizeErrorMargin &&
                                relativeBoxWidth < this.targetWidth + boxSizeErrorMargin &&
                                relativeBoxHeight > this.targetHeight - boxSizeErrorMargin &&
                                relativeBoxHeight < this.targetHeight + boxSizeErrorMargin;
        
            
                    // Section: AR target, targeting box positioning and position OK check
                    let center = frame.getCenter();
                    let currentTargetOffset = this.centerOffsets[this.imageIndex];
                    center.x = center.x + currentTargetOffset.x * this.centerMove;
                    center.y = center.y + currentTargetOffset.y * this.centerMove;
        
                    this.targetX = 50 + currentTargetOffset.x * this.centerMove * 100 * -1;
                    this.targetY = 50 + currentTargetOffset.y * this.centerMove * 100 * -1;

                    this.elements.targetBox.style.top = this.targetY + "%";
                    this.elements.targetBox.style.left = this.targetX + "%";
        
                    this.x = center.x * 100 - 50;
                    this.y = center.y * 100 - 50;
        
                    this.elements.target.style.transform = 'translate(' + this.x + '%, ' + this.y + '%)';
        
                    if(!this.takingPicture){

                        // Let's see if our camera is centered to the target
                        let positionOK = center.x < 0.52 && center.x > 0.48 && center.y < 0.52 && center.y > 0.48;
            
                        // Section: Angle check
                        let angle = frame.getAngle();
                        let angleOK = false;
                        let angleDirectionRight = null;
                        let angleThreshold = 3.5;
            
                        if (angle > 45 && angle < 90 - angleThreshold) {
                            angleDirectionRight = true;
                        } else if (angle <= 45 && angle > angleThreshold) {
                            angleDirectionRight = false;
                        } else {
                            angleOK = true;
                        }
            
                        // Layered error handling
                        // We start with angle check
                        if (positionOK && !angleOK) {
                            this.reticleError = true;
                            this.targetError = false;
                            this.setTooltip(this.tooltipStraight);
                        } else {
                            this.reticleError = false;
            
                            // Distance check
                            if (positionOK && !sizeOK) {
                                this.targetError = true;

                                // Too far
                                if(relativeBoxWidth < this.targetWidth - boxSizeErrorMargin || relativeBoxHeight < this.targetHeight - boxSizeErrorMargin){
                                    this.setTooltip(this.tooltipCloser);
                                // Too close
                                } else if (relativeBoxWidth > this.targetWidth + boxSizeErrorMargin || relativeBoxHeight > this.targetHeight + boxSizeErrorMargin){
                                    this.setTooltip(this.tooltipFurther);
                                }
                                

                                
                            // TODO: Add distinctive effects for when target is far away and when target is too close
                            } else {
                                this.targetError = false;
                            }
                        }

                        if(this.targetError){
                            this.elements.targetBox.style['border-color'] = 'red';
                        }else{
                            this.elements.targetBox.style['border-color'] = 'white';
                        }
            
                        // TODO: Standardize this to a set timing async routine and account for aspect ratios
                        if (positionOK && sizeOK && angleOK /* && topBotRatioOK && leftRightRatioOK*/) {
                            this.setTooltip(this.tooltipSteady);
                            this.progress += 100 / 60 * 3;
                            if (this.progress > 100) {
                                this.progress = 100;
                                this.takePicture();
                            }
                        } else {
                            this.progress = 0;
                        }

                        const offset = this.circumference - this.progress / 100 * this.circumference;
                        this.elements.progressCircle.style.strokeDashoffset = offset;
                    }
                }
            }
        }
    }

    async takePicture(){
        this.takingPicture = true;
        await this.Camera.takePicture("mjpeg");
    }

    onPictureTaken(base64ImageData){
        this.images.push(base64ImageData);
        this.takingPicture = false;
        this.progress = 0;
        this.takenPictures[this.imageIndex].src = base64ImageData;

        // After first image, we no longer need to show the target ghost image.
        if(this.imageIndex == 0){
            this.elements.targetBoxImg.style.opacity = 0;
        }

        // Update image index.
        this.imageIndex++;
        
        // Last image taken, let's begin transitioning to crop view
        if (this.imageIndex > 4) {
            this.pauseProcessing = true;
            this.imageIndex = 0;
            let self = this;
            setTimeout(function() {
                self.Camera.closeCameraStream();
                
                self.elements.cropView.style.display = "block";
                self.cropProcess(0);
            }, 1000);
        }
        
    }

    // Loops itself until it has processed all images
    async cropProcess(index) {
            var image = new Image();
            let self = this;
            image.onload = function() {
                self.processPhoto(image, index).then(()=>{
                    if(index+1 < self.images.length){
                        self.cropProcess(index+1);
                    }else{
                        self.elements.sendBtn.style.display = "block";
                    }
                });
            };
            image.src = this.images[index];
    }

    async processPhoto(image, index){
        this.elements.canvas.width = image.width;
        this.elements.canvas.height = image.height;
        let context = this.elements.canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        let imgData = context.getImageData(0, 0, this.elements.canvas.width, this.elements.canvas.height);
        
        // Then, construct a cv.Mat:
        let srcFull = cv.matFromImageData(imgData);
        let src = cv.matFromImageData(imgData);

        let top = 0;
        let left = 0;
        let right = srcFull.cols-1;
        let bottom = srcFull.rows-1;

        let width = Math.floor(src.cols/8);
        let height = Math.floor(src.rows/8);
        var size = new cv.Size(width, height);
        cv.resize(src, src, size, 0, 0, cv.INTER_AREA);

        // Apply edges
        // let edges = tm.getMergedEdges(src)
        let edges = tm.getEdges(src);

        // Apply contours
        let contours = tm.getContoursForEdges(edges);
        edges.delete();
        // Find largest shapes if any discovered
        if (contours.size() > 0) {
            let bounds = new cv.Rect(5, 5, size.width - 5, size.height - 5);
            let verticalBounds = true;
            let horizontalBounds = true;
            let largestContours = tm.getLargestContourIDs(contours, bounds, verticalBounds, horizontalBounds);

            // If we found large contours
            if (largestContours.length > 0) {
                
                let corners = tm.getCornersForContour(contours.get(largestContours[0]));
                if (corners != null) {
        
                    let points = [];
                    for (let i = 0; i < corners.size(); ++i) {
                        const ci = corners.get(i);
                        for (let j = 0; j < ci.data32S.length; j += 2) {
                            let p = {};
                            p.x = ci.data32S[j];
                            p.y = ci.data32S[j + 1];
                            points.push(p);
                        }
                    }
                    // Sort points so topmost points are first
                    points.sort(compareY);
                    top = points[0].y;
                    bottom = points[points.length-1].y;
        
                    // Sort points so that leftmost points are first
                    points.sort(compareX);
                    left = points[0].x;
                    right = points[points.length-1].x;
                    
                    let safeMargin = 100; //100 px safety margin

                    left = left*8 - safeMargin;
                    top = top*8 - safeMargin;
                    right = right*8 + safeMargin;
                    bottom = bottom*8 + safeMargin;

                    let black = new cv.Scalar(0, 0, 0, 255);

                    // Masking
                    cv.rectangle(srcFull, new cv.Point(0, 0), new cv.Point(left, srcFull.rows-1), black, -1);
                    cv.rectangle(srcFull, new cv.Point(0, 0), new cv.Point(srcFull.cols-1, top), black, -1);
                    cv.rectangle(srcFull, new cv.Point(right, 0), new cv.Point(srcFull.cols-1, srcFull.rows-1), black, -1);
                    cv.rectangle(srcFull, new cv.Point(0, bottom), new cv.Point(srcFull.cols-1, srcFull.rows-1), black, -1);

                    corners.delete();
                }
            }
        }
        cv.transpose(srcFull, srcFull);
        cv.flip(srcFull, srcFull, 0);
        cv.imshow('cvCanvas', srcFull);
        srcFull.delete();
        src.delete();
        
        let finalImg = this.elements.canvas.toDataURL("image/jpeg");
        this.cropPictures[index].src = finalImg;
        this.files.push(dataURLtoFile(finalImg, index+'.jpg'));
        
    }

    setLoaderText(text){
        this.elements.uploadMessage.innerHTML = text;
    }

    setTooltip(text){
        if(this.takingPicture){
            this.elements.tooltip.innerHTML = this.tooltipSteady;
        } else {
            this.elements.tooltip.innerHTML = text;
        }
    }

    sendForAnalysis(){
        console.log("Send pressed");
        this.elements.uploadView.style.display = "block";
        this.setLoaderText("Sending images for analysis...");
        let self = this;

        var data = new FormData();

        for(let i = 0; i < this.files.length; i++){            
            data.append("file", this.files[i]);
        } 
        data.append("device_id", "EPI");
        data.append("latitude", "0");
        data.append("longitude", "0");
        data.append("scan_type", "package");
        data.append("instance_id", "ae86e21d-c634-4d2d-a4be-011d86aa5715");

        var xhr = new XMLHttpRequest();
        xhr.withCredentials = true;

        xhr.addEventListener("readystatechange", function() {
            if(this.readyState === 4) {
                console.log(this.responseText);
                const response = JSON.parse(this.responseText);
                console.log(response);
                if(response.success){
                    self.getTicket(response.data.ticket_number);
                }else{
                    console.log('no success');
                }
            } else {
                console.log(this.readyState);
            }
        });

        

        
        xhr.addEventListener("progress", function(evt){
            if (evt.lengthComputable) { 
                self.setLoaderText(Math.round(evt.loaded / evt.total * 100) + "%");  
            }  
        }, false);

        xhr.addEventListener('error', function() {
            console.log('error');
        });

        xhr.open("POST", api+"/scan/identify");
        xhr.setRequestHeader('Cache-Control','no-cache');
        xhr.setRequestHeader("X-API-KEY", apiKey);
        xhr.setRequestHeader("X-INSTALL-ID", installId);
        xhr.send(data);
    }

    getTicket(ticket){
        this.setLoaderText("Analysing...");
        let self = this;
        
        var xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        
        xhr.addEventListener("readystatechange", function() {
            if(this.readyState === 4) {
                const response = JSON.parse(this.responseText);
                const status = response.data.scan_result.scan_status;
                if(status == "pending"){
                    setTimeout(function() {self.getTicket(ticket);}, 2000);
                    //self.getTicket(ticket);
                // Result complete
                }else{
                    const result = response.data.scan_result;
                    //TODO: Catch errors from AI...

                    // Authentic
                    if(result.confidence == 100){
                        self.report(true, undefined);
                    // Counterfeit
                    }else{
                        self.report(false, undefined);
                    }
                }
            }
        });

        
        xhr.open("GET", api+"/scan/"+ticket);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader('Cache-Control','no-cache');
        xhr.setRequestHeader("X-API-KEY", apiKey);
        xhr.setRequestHeader("X-INSTALL-ID", installId);

        xhr.send();
    }

    // Get product using code, then queue an instance request using product code
    getCode(code){
        let self = this;
        
        var xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        
        xhr.addEventListener("readystatechange", function() {
            if(this.readyState === 4) {
                const response = JSON.parse(this.responseText);
                
                const product = response.data.trace_code.product.public_id;
                self.getInstance(product);
            }
        });

        
        xhr.open("GET", api+"/code_scanner/"+code);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader('Cache-Control','no-cache');
        xhr.setRequestHeader("X-API-KEY", apiKey);
        xhr.setRequestHeader("X-INSTALL-ID", installId);

        xhr.send();
    }

    // Get package size and instance id and graphic
    getInstance(product){

        var data = JSON.stringify({"filter":{
            "product": product,
            "active": 1,
            "authenticity": 1
        }});

        let self = this;
        var xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        
        xhr.addEventListener("readystatechange", function() {
            if(this.readyState === 4) {
                const response = JSON.parse(this.responseText);
                
                const instance = response.data.instances[0];
                const id = instance.public_id;
                const width = instance.package_width;
                const height = instance.package_height;
                const img = api + "/instance"+instance.logo;

                self.setProduct(width, height);
                self.downloadImage(img);
            }
        });

        xhr.open("POST", api+"/instance/search/1");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader('Cache-Control','no-cache');
        xhr.setRequestHeader("X-API-KEY", apiKey);
        xhr.setRequestHeader("X-INSTALL-ID", installId);

        xhr.send(data);
    }

    downloadImage(url) {
        
        let self = this;
        var xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        xhr.responseType = 'blob';
        
        xhr.onload = function () {
            if (xhr.status === 200) {
                // If successful, set img
                self.elements.targetBoxImg.src = window.URL.createObjectURL(xhr.response);
            } else {
                // If it fails, just log an error for now
                console.log('Image didn\'t load successfully; error code:' + request.statusText);
            }
        };

        xhr.open("GET", url);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader('Cache-Control','no-cache');
        xhr.setRequestHeader("X-API-KEY", apiKey);
        xhr.setRequestHeader("X-INSTALL-ID", installId);

        xhr.send();
    }

    async verifyPack(){
        const self = this;

        const showError = function(error){
            self.showErrorModal("Authentication Feature", error.message || error);
        }

        await self.scanCode((err, scanData) => {
            if (err)
                return showError(`Could not scan Pack`);
            if (!scanData)
                return console.log(`No data scanned`);
            const isValid = self.verify(scanData);
            self.report(isValid, isValid ? undefined : "Package is not valid");
        });
    }



    async scanCode(callback){
        const self = this;
        await self.barcodeScannerController.present((err, scanData) => err
                ? callback(err)
                : callback(undefined, scanData ? self.parseScanData(scanData.result) : scanData));
    }

    parseScanData(result){
        const interpretedData = interpretGS1scan.interpretScan(result);
        const data = interpretedData.AIbrackets.split(/\(\d{1,2}\)/g);
        result = {
            gtin: data[1],
            expiry: data[2],
            batchNumber: data[3],
            serialNumber: data[4]
        }
        return result;
    }

    verify(scanData){
        const self = this;
        return Object.keys(scanData).every(key => {
            if (key === 'expiry'){
                const dateA = new Date(scanData[key].replace(/(\d{2})(\d{2})(\d{2})/g,'$2/$3/$1')).getTime();
                const dateB = new Date(self.model.gs1Data[key].replaceAll(" - ", "/")).getTime();
                return dateA === dateB;
            }
            return scanData[key] === self.model.gs1Data[key];
        });
    }

    report(status, error){
        const event = new CustomEvent('ssapp-action', {
            bubbles: true,
            cancelable: true,
            detail: new AuthFeatureResponse(status, error)
        });
        this.element.dispatchEvent(event);
    }
}

