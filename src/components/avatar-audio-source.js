import { SourceType, AvatarAudioDefaults, TargetAudioDefaults } from "./audio-params";
import { MixerType } from "../systems/audio-system";
const INFO_INIT_FAILED = "Failed to initialize avatar-audio-source.";
const INFO_NO_NETWORKED_EL = "Could not find networked el.";
const INFO_NO_OWNER = "Networked component has no owner.";

// Chrome seems to require a MediaStream be attached to an AudioElement before AudioNodes work correctly
// We don't want to do this in other browsers, particularly in Safari, which actually plays the audio despite
// setting the volume to 0.
const SHOULD_CREATE_SILENT_AUDIO_ELS = /chrome/i.test(navigator.userAgent);
function createSilentAudioEl(stream) {
  const audioEl = new Audio();
  audioEl.setAttribute("autoplay", "autoplay");
  audioEl.setAttribute("playsinline", "playsinline");
  audioEl.srcObject = stream;
  audioEl.volume = 0; // we don't actually want to hear audio from this element
  return audioEl;
}

async function getOwnerId(el) {
  const networkedEl = await NAF.utils.getNetworkedEntity(el).catch(e => {
    console.error(INFO_INIT_FAILED, INFO_NO_NETWORKED_EL, e);
  });
  if (!networkedEl) {
    return null;
  }
  return networkedEl.components.networked.data.owner;
}

async function getMediaStream(el) {
  const peerId = await getOwnerId(el);
  if (!peerId) {
    console.error(INFO_INIT_FAILED, INFO_NO_OWNER);
    return null;
  }
  const stream = await APP.dialog.getMediaStream(peerId).catch(e => {
    console.error(INFO_INIT_FAILED, `Error getting media stream for ${peerId}`, e);
  });
  if (!stream) {
    return null;
  }
  return stream;
}

AFRAME.registerComponent("avatar-audio-source", {
  createAudio: async function() {
    this.isCreatingAudio = true;
    const stream = await getMediaStream(this.el);
    this.isCreatingAudio = false;
    const isRemoved = !this.el.parentNode;
    if (!stream || isRemoved) return;

    const audioListener = this.el.sceneEl.audioListener;
    const audio = new THREE.PositionalAudio(audioListener);
    this.el.setAttribute("audio-params", {
      sourceType: SourceType.AVATAR_AUDIO_SOURCE,
      distanceModel: AvatarAudioDefaults.DISTANCE_MODEL,
      rolloffFactor: AvatarAudioDefaults.ROLLOFF_FACTORROLLOFF_FACTOR,
      refDistance: AvatarAudioDefaults.REF_DISTANCE,
      maxDistance: AvatarAudioDefaults.MAX_DISTANCE,
      coneInnerAngle: AvatarAudioDefaults.INNER_ANGLE,
      coneOuterAngle: AvatarAudioDefaults.OUTER_ANGLE,
      coneOuterGain: AvatarAudioDefaults.OUTER_GAIN,
      gain: AvatarAudioDefaults.VOLUME
    });
    this.el.components["audio-params"].setAudio(audio);

    this.audioSystem.removeAudio(audio);
    this.audioSystem.addAudio(MixerType.AVATAR, audio);

    if (SHOULD_CREATE_SILENT_AUDIO_ELS) {
      createSilentAudioEl(stream); // TODO: Do the audio els need to get cleaned up?
    }

    this.destination = audio.context.createMediaStreamDestination();
    this.mediaStreamSource = audio.context.createMediaStreamSource(stream);
    this.gainFilter = audio.context.createGain();
    const destinationSource = audio.context.createMediaStreamSource(this.destination.stream);
    this.mediaStreamSource.connect(this.gainFilter);
    this.gainFilter.connect(this.destination);
    audio.setNodeSource(destinationSource);
    this.el.setObject3D(this.attrName, audio);
    this.el.emit("sound-source-set", { soundSource: destinationSource });
  },

  destroyAudio() {
    const audio = this.el.getObject3D(this.attrName);
    if (!audio) return;

    this.audioSystem.removeAudio(audio);
    this.el.removeObject3D(this.attrName);
  },

  init() {
    this.audioSystem = this.el.sceneEl.systems["hubs-systems"].audioSystem;
    this.el.sceneEl.systems["hubs-systems"].audioSettingsSystem.registerAvatarAudioSource(this);
    // We subscribe to audio stream notifications for this peer to update the audio source
    // This could happen in case there is an ICE failure that requires a transport recreation.
    APP.dialog.on("stream_updated", this._onStreamUpdated, this);
    this.createAudio();
  },

  async _onStreamUpdated(peerId, kind) {
    const audio = this.el.getObject3D(this.attrName);
    if (!audio) return;
    const stream = audio.source.mediaStream;
    if (!stream) return;

    getOwnerId(this.el).then(async ownerId => {
      if (ownerId === peerId && kind === "audio") {
        // The audio stream for this peer has been updated
        const newStream = await APP.dialog.getMediaStream(peerId, "audio").catch(e => {
          console.error(INFO_INIT_FAILED, `Error getting media stream for ${peerId}`, e);
        });

        if (newStream) {
          this.mediaStreamSource.disconnect();
          this.mediaStreamSource = audio.context.createMediaStreamSource(newStream);
          this.mediaStreamSource.connect(this.destination);
        }
      }
    });
  },

  remove: function() {
    this.el.sceneEl.systems["hubs-systems"].audioSettingsSystem.unregisterAvatarAudioSource(this);
    APP.dialog.off("stream_updated", this._onStreamUpdated);
    this.destroyAudio();
  },

  getGainFilter() {
    return this.gainFilter;
  }
});

function createWhiteNoise(audioContext, gain) {
  const bufferSize = 2 * audioContext.sampleRate,
    noiseBuffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate),
    gainFilter = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    gainFilter[i] = (Math.random() * 2 - 1) * gain;
  }

  const whiteNoise = audioContext.createBufferSource();
  whiteNoise.buffer = noiseBuffer;
  whiteNoise.loop = true;
  whiteNoise.start(0);
  return whiteNoise;
}

const tmpWorldPos = new THREE.Vector3();

/**
 * @component zone-audio-source
 * This component looks for audio sources that get near it, keeping track
 * of them and making them available to other components. It currently only
 * supports avatars via the avatar-audio-source component, and only a single
 * source at a time, but this can easily be expanded in the future.
 */
AFRAME.registerComponent("zone-audio-source", {
  schema: {
    onlyMods: { default: true },
    muteSelf: { default: true },

    debug: { default: false }
  },

  init() {
    const audioListener = this.el.sceneEl.audioListener;
    const ctx = audioListener.context;
    this.gainFilter = ctx.createGain();
    if (this.data.debug) {
      this.whiteNoise = createWhiteNoise(ctx, 0.01);
      this.setInput(this.whiteNoise);
    }

    // TODO this should probably be using bounds similar to media-frames and trigger-volume.
    // Doing the simple thing for now since we only support avatar audio sources currently
    this.el.object3D.updateMatrixWorld();
    const radius = this.el.object3D.matrixWorld.getMaxScaleOnAxis();
    this.boundingRadiusSquared = radius * radius;

    if (this.data.debug) {
      this.el.setObject3D(
        "debug",
        new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereBufferGeometry(1, 10, 10)))
      );
    }
  },

  setInput(newInput) {
    if (this.input) {
      this.input.disconnect(this.gainFilter);
      this.input = null;
    }

    if (newInput) {
      newInput.connect(this.gainFilter);
      this.input = newInput;
    }
  },

  getGainFilter() {
    return this.gainFilter;
  },

  tick() {
    this.el.object3D.getWorldPosition(tmpWorldPos);
    if (this.trackingEl) {
      const distanceSquared = this.trackingEl.object3D.position.distanceToSquared(tmpWorldPos);
      if (distanceSquared > this.boundingRadiusSquared) {
        this.trackingEl = null;
        this.setInput(this.whiteNoise);
      }
    } else {
      const playerInfos = window.APP.componentRegistry["player-info"];
      for (let i = 0; i < playerInfos.length; i++) {
        const playerInfo = playerInfos[i];
        const avatar = playerInfo.el;

        if (this.data.onlyMods && !playerInfo.can("amplify_audio")) continue;

        const distanceSquared = avatar.object3D.position.distanceToSquared(tmpWorldPos);
        if (distanceSquared < this.boundingRadiusSquared) {
          this.trackingEl = avatar;
          if (this.data.muteSelf && this.trackingEl.id === "avatar-rig") {
            // Don't emit your own audio
            this.setInput(null);
          } else {
            getMediaStream(this.trackingEl).then(stream => {
              const audioListener = this.el.sceneEl.audioListener;
              const ctx = audioListener.context;
              const node = ctx.createMediaStreamSource(stream);
              this.setInput(node);
            });
          }
        }
      }
    }
  }
});

/**
 * @component audio-target
 * This component pulls audio from a "source" component and re-emits it.
 * Currently the audio can come from a zone-audio-source. A gain as well
 * as a random delay can be applied in addition to the standard positional
 * audio properties, to better simulate a real world speaker setup.
 */
AFRAME.registerComponent("audio-target", {
  schema: {
    minDelay: { default: 0.01 },
    maxDelay: { default: 0.13 },
    srcEl: { type: "selector" },
    debug: { default: false }
  },

  init() {
    this.audioSystem = this.el.sceneEl.systems["hubs-systems"].audioSystem;
    this.el.setAttribute("audio-params", {
      sourceType: SourceType.AUDIO_TARGET,
      distanceModel: TargetAudioDefaults.DISTANCE_MODEL,
      rolloffFactor: TargetAudioDefaults.ROLLOFF_FACTOR,
      refDistance: TargetAudioDefaults.REF_DISTANCE,
      maxDistance: TargetAudioDefaults.MAX_DISTANCE,
      coneInnerAngle: TargetAudioDefaults.INNER_ANGLE,
      coneOuterAngle: TargetAudioDefaults.OUTER_ANGLE,
      coneOuterGain: TargetAudioDefaults.OUTER_GAIN,
      gain: TargetAudioDefaults.VOLUME
    });
    this.createAudio();
    // TODO this is to ensure targets and sources loaded at the same time don't have
    // an order depndancy but this should be done in a more robust way
    setTimeout(() => {
      this.connectAudio();
    }, 0);
    this.el.setAttribute("audio-zone-source");
  },

  remove: function() {
    this.destroyAudio();
    this.el.removeAttribute("audio-params");
    this.el.removeAttribute("audio-zone-source");
  },

  createAudio: function() {
    const audioListener = this.el.sceneEl.audioListener;
    const audio = new THREE.PositionalAudio(audioListener);

    if (this.data.maxDelay > 0) {
      const delayNode = audio.context.createDelay(this.data.maxDelay);
      delayNode.delayTime.value = THREE.Math.randFloat(this.data.minDelay, this.data.maxDelay);
      audio.setFilters([delayNode]);
    }

    this.gainFilter = THREE.AudioContext.getContext().createGain();

    this.el.setObject3D(this.attrName, audio);
    audio.matrixNeedsUpdate = true;
    audio.updateMatrixWorld();
    this.audio = audio;

    this.audioSystem.removeAudio(this.audio);
    this.audioSystem.addAudio(MixerType.MEDIA, this.audio);

    const filters = this.audio.getFilters();
    filters.push(this.gainFilter);
    this.audio.setFilters(filters);

    this.el.components["audio-params"].setAudio(audio);

    this.audio.updateMatrixWorld();
  },

  connectAudio() {
    const srcEl = this.data.srcEl;
    const srcZone = srcEl && srcEl.components["zone-audio-source"];
    const node = srcZone && srcZone.getGainFilter();
    if (node) {
      this.audio.setNodeSource(node);
    } else {
      console.warn(`Failed to get audio from source for ${this.el.className}`, srcEl);
    }
  },

  destroyAudio() {
    const audio = this.el.getObject3D(this.attrName);
    if (!audio) return;

    this.audioSystem.removeAudio(this.audio);
    this.el.removeObject3D(this.attrName);
  },

  getGainFilter() {
    return this.gainFilter;
  }
});
