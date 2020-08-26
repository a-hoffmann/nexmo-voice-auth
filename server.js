'use strict'
require('dotenv').load()
const fs = require('fs');
const util = require('util');
const express = require('express');
const bodyParser = require('body-parser')
const app = express();
const expressWs = require('express-ws')(app);
var header = require("waveheader");
const axios = require('axios');
var createBuffer = require('audio-buffer-from');

const WaveFile = require('wavefile').WaveFile;
var wav = new WaveFile();

const Nexmo = require('nexmo');
const { Readable } = require('stream');
const { Writable } = require('stream');
const speech = require('@google-cloud/speech');

const TIE = require('@artificialsolutions/tie-api-client');

const voiceName = process.env.NEXMO_VOICE || 'Brian';
const sttLang = process.env.STT_LANG_CODE || 'en-GB';
const ttsLang = process.env.TTS_LANG_CODE || 'en-GB';
const ttsLangName = process.env.TTS_LANG_NAME || '';
const ttsGender = process.env.TTS_GENDER || 'NEUTRAL';

const recording = process.env.RECORDING || false;
let config = null;
var sessionUniqueID = null;
var striptags = require('striptags');
var streamResponse;

const voiceit2 = require('voiceit2-nodejs');
var myVoiceIt = new voiceit2(process.env.VOICEIT_KEY, process.env.VOICEIT_TOKEN);
const AUDIO_FILE_NAME = 'verif.wav';
var file = null;
var msgBufd = [];
const voiceItUserId=process.env.VOICEIT_USER_ID
const passphrase = process.env.VOICEIT_PASSPHRASE

//set from Teneo
var endCall = false;
global.voiceAuthObj = {};
var authInProgress = false;

const nexmo = new Nexmo({
  apiKey: process.env.NEXMO_API_KEY,
  apiSecret: process.env.NEXMO_API_SECRET,
  applicationId: process.env.APP_ID,
  privateKey: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
});

/**
 * Separate configuration file for Google cloud STT.
 * NOTE: You _have_ to keep a seperate variable for projectId and KeyFileName, otherwise there will be an exception.
 * You can allow Google TTS and STT in the same project for both variables.
 * @type {{keyFilename: string, projectId: string}}
 */
const stt_config = {
    projectId: 'stt-tts-1582249946541',
    credentials: {
		client_email: process.env.GOOGLE_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
	}
};

const stt = require('@google-cloud/speech').v1p1beta1;
const google_stt_client = new stt.SpeechClient(stt_config);

  let streamingLimit = 600000; //600 sec
  let recognizeStream = null;
  let restartCounter = 0;
  let audioInput = [];
  let lastAudioInput = [];
  let resultEndTime = 0;
  let isFinalEndTime = 0;
  let finalRequestEndTime = 0;
  let newStream = true;
  let bridgingOffset = 0;
  let lastTranscriptWasFinal = false;

/**
 * Separate configuration file for Google cloud TTS.
 * NOTE: You _have_ to keep a seperate variable for projectId and KeyFileName, otherwise there will be an exception.
 * You can allow Google TTS and STT in the same project for both variables.
 * @type {{keyFilename: string, projectId: string}}
 */

const tts_config = {
    projectId: 'stt-tts-1582249946541',
    credentials: {
		client_email: process.env.GOOGLE_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
	}
};

const tts = require('@google-cloud/text-to-speech');
const google_tts_client = new tts.TextToSpeechClient(tts_config);

/**
 * Variables
 */

// Global variable to keep track of the caller
var CALL_UUID = null;
var CALLER = null;
// Change between "google" or "nexmo"
var tts_response_provider = process.env.TTS_RESPONSE_PROVIDER || 'nexmo';
var your_hostname = "";

/**
 *
 * @type {{interimResults: boolean, config: {sampleRateHertz: number, encoding: string, languageCode: string}}}
 */
/**
 * Configuration variable for Google.
 * @type {{interimResults: boolean, config: {sampleRateHertz: number, encoding: string, languageCode: string}}}
 */

let stream_request ={
    config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 8000,
        languageCode: sttLang
    },
    interimResults: false
};

/**
 * Server configuration
 */

app.use(bodyParser.json());
app.use(express.static('public'));
app.use(express.static('files'));

/**
 * POST response for the default events parameter
 */

app.post('/webhooks/events', (req, res) => {
	if (req.body.recording_url) {
		console.log('Recording available at: ',req.body.recording_url)
	}
    res.sendStatus(200);
});

/**
 * GET response to retrieve the locally saved verification audio file.
 */

app.get('/' + AUDIO_FILE_NAME, function(req, res){
    res.sendFile(`${__dirname}/` + AUDIO_FILE_NAME);
});



/**
 * GET response for the default answer parameter. Required to initialise the conversation with caller.
 */

app.get('/webhooks/answer', (req, res) => {

    your_hostname = `${req.hostname}`;

    let nccoResponse = [
	/*{
    "action": "talk",
    "text": "Hello, this is the IVR test system.",
    "voiceName": voiceName,
    "bargeIn": false
  },*/
        {
            "action": "connect",
            "endpoint": [{
                "type": "websocket",
                "content-type": "audio/l16;rate=8000",
                "uri": `ws://${req.hostname}/socket`,
                // The headers parameter will be passed in the config variable below.
                "headers": {
                    "language": sttLang,
                    "uuid": req.url.split("&uuid=")[1].toString(),
					"caller": req.url.split("&from=")[1].split("&")[0].toString()
					//"caller": req.url.split("&from=")[1].split("&")[0]
                }
            }],
        }
    ];
	
	if (recording==="true") {nccoResponse.unshift({"action": "record",
	"eventUrl": [`https://${req.hostname}/webhooks/events`]
	})}
	
    res.status(200).json(nccoResponse);
});

/**
 * Websocket communicating with Nexmo and the end-user via the active phone call.
 * CALL_UUID parameter is passed to
 */

app.ws('/socket', (ws, req) => {
	
	streamResponse = ws;
	
    // Initialised after answer webhook has started
    ws.on('message', (msg) => {

        if (typeof msg === "string") {
            // UUID is captured here.
            let config = JSON.parse(msg);
            CALL_UUID = config["uuid"];
			CALLER = config["caller"]
			console.log('Call starting: uuid ',CALL_UUID)
			processContent(''); //send empty string for login
			startStream();
        }

        // Send the user input as byte array to Google STT
        else {
            sendStream(msg)
        }
    });

    // Initiated when caller hangs up.
    ws.on('close', () => {
        recognizeStream.destroy();
    })
	
	// Refresh to keep the session alive
/*setInterval(function () {
    ws.send("");
}, 25000);*/

	
});

/**
 * Initialise the server after defining the server functions.
 */
const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Server started using port ${port}!`));



/**
 * Auth goes here
 */
async function sendStream(msg) {
    await recognizeStream.write(msg);
	
	if (authInProgress) {
	//create a temp stream
	//write msg into it
	msgBufd.push(msg); //320 bytes
		}
}

async function doAuth(userId, phrase, rec) {

	rec = Buffer.concat([header(rec.length, {sampleRate: 8000, channels: 1, bitDepth: 16}),rec]);
	
	const writeFile = util.promisify(fs.writeFile);

    // Write the binary audio content to a local file
    await writeFile(AUDIO_FILE_NAME, rec, 'binary');
	
	return new Promise(function(resolve, reject) {
		myVoiceIt.voiceVerificationByUrl({
  userId : userId,
  contentLanguage : "en-US",
  phrase : phrase,
  audioFileURL : 'https://' + your_hostname + '/' + AUDIO_FILE_NAME
},(authResponse)=>{
	//get the output of this
  //console.log(authResponse);
  if (authResponse.status == 200) {
  authInProgress=false;
  resolve(authResponse.confidence);
  }
  else {
	  resolve(authResponse.message)
  }
	}); });
}




/**
 * Google STT function. When the data has been retrieved from Google cloud, processing from text to response speech is started.
 */
   function startStream() {
    // Clear current audioInput
    audioInput = [];
    // Initiate (Reinitiate) a recognize stream
recognizeStream = google_stt_client
    .streamingRecognize(stream_request)
    .on('error', err => {
		if (err.code === 4) {
          console.log('Error code 4, restarting');
		  //restartStream(recognizeStream);
        } 
          console.error('API request error ' + err.message);
	})
     .on('data', speechCallback);
    // Restart stream when streamingLimit expires
    setTimeout(restartStream, streamingLimit);
   }


/**
 * processContent is an asynchronous function to send input and retrieve output from a Teneo instance.
 * After this is completed, Google or Nexmo TTS is initiated.
 * @param transcript Transcripted text from Google
 */
async function processContent(transcript) {
    await TIE.sendInput(process.env.TENEO_ENGINE_URL, sessionUniqueID, { text: transcript, channel: 'IVR', phone: CALLER} )
        .then((response) => {
                console.log("Speech-to-text user output: " + transcript);
				//insert SSML here
				transcript = response.output.text
                if (!response.output.parameters.isSSML) { striptags(transcript) }
				console.log("Bot response: " + transcript);
				if (response.output.parameters.authInProgress==="true") {
					authInProgress = true
					voiceAuthObj=response.output.parameters.voiceAuthObj;
					console.log("auth to be started, obj is ",voiceAuthObj)
				}
                return response
            }
        ).then(({sessionId}) => sessionUniqueID = sessionId);
		
    sendTranscriptVoiceNoSave(transcript);
}

/**
 * processContent is an asynchronous function to send input and retrieve output from a Teneo instance.
 * After this is completed, Google or Nexmo TTS is initiated.
 * @param transcript Transcripted text from Google
 */
async function processContentAuth(transcript, authResult) {
    await TIE.sendInput(process.env.TENEO_ENGINE_URL, sessionUniqueID, { text: transcript, channel: 'IVR', verifyResult: authResult} )
        .then((response) => {
                console.log("Speech-to-text user output: " + transcript);
				//insert SSML here
				transcript = response.output.text
                if (!response.output.parameters.isSSML) { striptags(transcript) }
				console.log("Bot response: " + transcript);
				if (response.output.parameters.authInProgress==="true") {
					authInProgress = true
					voiceAuthObj=response.output.parameters.voiceAuthObj;
					console.log("auth starting")
				}
                return response
            }
        ).then(({sessionId}) => sessionUniqueID = sessionId);
		
    sendTranscriptVoiceNoSave(transcript);
}

/**
 * sendTranscriptVoiceNoSave performs Google/Nexmo TTS operation and Nexmo returns the audio back to the end user. 
 * Does not save the file as a .MP3 file in the app folder.
 * @param transcript Message to be sent back to the end user
 */

async function sendTranscriptVoiceNoSave(transcript) {
	
	function sendAudioInSequence (item, callback) {
  setTimeout(() => {
    streamResponse.send(item);
    callback();
  }, 15);
}

    // Google voice response
    if(tts_response_provider === "google") {
		var reqToSynthethize = {
        input: (transcript.startsWith("<speak")) ? {ssml: transcript} : {text: transcript},
        // Select the language and SSML voice gender (optional) 
        voice: {languageCode: ttsLang, name: ttsLangName, ssmlGender: 'FEMALE'},
        // select the type of audio encoding
        audioConfig: {audioEncoding: 'LINEAR16', sampleRateHertz: 8000}, 
    }
	
    // Performs the text-to-speech request
    const [response] = await google_tts_client.synthesizeSpeech(reqToSynthethize);
	
		/*formatForNexmo(response.audioContent,640).forEach(function(aud) {
			console.log(aud.length);
			streamResponse.send(aud);
			console.log("sent");
		});*/
		let requestz = formatForNexmo(response.audioContent,320).reduce((promiseChain, item) => {
			return promiseChain.then(() => new Promise((resolve) => {
				sendAudioInSequence(item, resolve);
			}));
			}, Promise.resolve());

		//requestz.then(() => console.log('done'))

		if (endCall) {
			
					nexmo.calls.update(CALL_UUID,{action:'hangup'},console.log('call ended'))
					//streamResponse.close()
				}
    }
	
	if(tts_response_provider === "test") {
		axios.post(testEndpoint, {
		Text: transcript,
        Checkbox: true,
        Person: testVoiceName 
  }).then(function (testResponse) {
	  
	  wav.fromBase64(testResponse.data.encoded);
	  wav.toSampleRate(16000, {method: "linear"}); //other supported: cubic
	  
		/*formatForNexmo(wav.toBuffer(),640).forEach(function(aud) {
			streamResponse.send(aud);
		});*/
		
		let requestz = formatForNexmo(wav.toBuffer(),640).reduce((promiseChain, item) => {
			return promiseChain.then(() => new Promise((resolve) => {
				sendAudioInSequence(item, resolve);
			}));
			}, Promise.resolve());

		//requestz.then(() => console.log('done'))
		
		if (endCall) {
			
					nexmo.calls.update(CALL_UUID,{action:'hangup'},console.log('call ended'))
					//streamResponse.close()
				}
  }).catch(function (error) {
    console.log(error);
  });
    }

    // Nexmo voice response
    else if(tts_response_provider === "nexmo") {
		console.log("sending to call uuid", CALL_UUID);
        nexmo.calls.talk.start(CALL_UUID, { text: transcript, voice_name: 'Emma', loop: 1 }, (err, res) => {
            if(err) { console.error(err); }
            else {
                console.log("Nexmo response sent: " + res);
				if (endCall) {
					nexmo.calls.update(CALL_UUID,{action:'hangup'},console.log('call ended'))
				}
            }
        });
    }	
}

     

  const speechCallback = stream => {
    // Convert API result end time from seconds + nanoseconds to milliseconds
    resultEndTime =
      stream.results[0].resultEndTime.seconds * 1000 +
      Math.round(stream.results[0].resultEndTime.nanos / 1000000);

    // Calculate correct time based on offset from audio sent twice
    const correctedTime =
      resultEndTime - bridgingOffset + streamingLimit * restartCounter;

    //process.stdout.clearLine();
    //process.stdout.cursorTo(0);
    let stdoutText = '';
    if (stream.results[0] && stream.results[0].alternatives[0]) {
      stdoutText =
        correctedTime + ': ' + stream.results[0].alternatives[0].transcript;
    }
	
	var utterance = stream.results[0].alternatives[0].transcript
		if (!authInProgress) {
        processContent(utterance);
		//
		}
	if (authInProgress) {
		var verifAudio;
		//length of audio must be < 5 sec, we can trim before concatenating
		if (msgBufd.length>250) {
			verifAudio=Buffer.concat(msgBufd.slice(Math.abs(msgBufd.length-250),msgBufd.length-1))
			}
			else {verifAudio = Buffer.concat(msgBufd)}
			//console.log("auth for user ",voiceItUserId);
		
			doAuth(voiceItUserId, passphrase, verifAudio).then((authResult) => {
		console.log("auth finished, got",authResult);
		processContentAuth(utterance, authResult);
		});
	}
	
  };

  const audioInputStreamTransform = new Writable({
    write(chunk, encoding, next) {
      if (newStream && lastAudioInput.length !== 0) {
        // Approximate math to calculate time of chunks
        const chunkTime = streamingLimit / lastAudioInput.length;
        if (chunkTime !== 0) {
          if (bridgingOffset < 0) {
            bridgingOffset = 0;
          }
          if (bridgingOffset > finalRequestEndTime) {
            bridgingOffset = finalRequestEndTime;
          }
          const chunksFromMS = Math.floor(
            (finalRequestEndTime - bridgingOffset) / chunkTime
          );
          bridgingOffset = Math.floor(
            (lastAudioInput.length - chunksFromMS) * chunkTime
          );

          for (let i = chunksFromMS; i < lastAudioInput.length; i++) {
            recognizeStream.write(lastAudioInput[i]);
          }
        }
        newStream = false;
      }

      audioInput.push(chunk);

      if (recognizeStream) {
        recognizeStream.write(chunk);
      }

      next();
    },

    final() {
      if (recognizeStream) {
        recognizeStream.end();
      }
    },
  });

  function restartStream() {
    if (recognizeStream) {
      recognizeStream.removeListener('data', speechCallback);
      recognizeStream = null;
    }
    if (resultEndTime > 0) {
      finalRequestEndTime = isFinalEndTime;
    }
    resultEndTime = 0;

    lastAudioInput = [];
    lastAudioInput = audioInput;

    restartCounter++;

    if (!lastTranscriptWasFinal) {
      process.stdout.write('\n');
    }
    process.stdout.write(
      //console.log(`${streamingLimit * restartCounter}: RESTARTING REQUEST\n`)
    );

    newStream = true;

    startStream();
  }

/**
 * Constructs the byte array to be written to the Nexmo Websocket, in packets of byteLen length.
 * @param ac Audio response Buffer
 */
function formatForNexmo(ac,byteLen) {
	var totalByteLength = Buffer.byteLength(ac);
	//console.log('byteLength ',totalByteLength);
	
    var msgLength = byteLen; // bytes
   
    var bufQueue=[];
    for (var i=0;i<totalByteLength;i+=msgLength) {
	    bufQueue.push(ac.slice(i,i+msgLength));
    }
	//console.log("bufQueue length",bufQueue.length);
    return bufQueue;
}