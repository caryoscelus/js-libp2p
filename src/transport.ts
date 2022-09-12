import * as sdp from './sdp';
import * as p from '@libp2p/peer-id';
import { WebRTCConnection } from './connection';
import { WebRTCDialOptions } from './options';
import { WebRTCStream } from './stream';
import { Noise } from '@chainsafe/libp2p-noise';
import { Components, Initializable } from '@libp2p/components';
import { Connection } from '@libp2p/interface-connection';
import type { PeerId } from '@libp2p/interface-peer-id';
import { CreateListenerOptions, Listener, symbol, Transport } from '@libp2p/interface-transport';
import { logger } from '@libp2p/logger';
import { Multiaddr } from '@multiformats/multiaddr';
import { v4 as genUuid } from 'uuid';
import defer, { DeferredPromise } from 'p-defer';
import { fromString as uint8arrayFromString } from 'uint8arrays/from-string';
import { concat } from 'uint8arrays/concat';
import * as multihashes from 'multihashes';
import { dataChannelError, inappropriateMultiaddr, unimplemented, invalidArgument, unsupportedHashAlgorithm } from './error';
import { compare as uint8arrayCompare } from 'uint8arrays/compare';

const log = logger('libp2p:webrtc:transport');
const HANDSHAKE_TIMEOUT_MS = 10000;

export class WebRTCTransport implements Transport, Initializable {
  private componentsPromise: DeferredPromise<void> = defer();
  private components: Components | undefined;

  init(components: Components): void {
    this.componentsPromise.resolve();
    this.components = components;
  }

  async dial(ma: Multiaddr, options: WebRTCDialOptions): Promise<Connection> {
    const rawConn = await this._connect(ma, options);
    log(`dialing address - ${ma}`);
    return rawConn;
  }

  createListener(options: CreateListenerOptions): Listener {
    throw unimplemented('WebRTCTransport.createListener');
  }

  filter(multiaddrs: Multiaddr[]): Multiaddr[] {
    return multiaddrs.filter(validMa);
  }

  get [Symbol.toStringTag](): string {
    return '@libp2p/webrtc';
  }

  get [symbol](): true {
    return true;
  }

  async _connect(ma: Multiaddr, options: WebRTCDialOptions): Promise<Connection> {
    let rps = ma.getPeerId();
    if (!rps) {
      throw inappropriateMultiaddr("we need to have the remote's PeerId");
    }

    let certificate = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
    } as any);
    let peerConnection = new RTCPeerConnection({ certificates: [certificate] });

    // create data channel
    let dataChannelOpenPromise = defer();
    let handshakeDataChannel = peerConnection.createDataChannel('data', { negotiated: true, id: 1 });
    handshakeDataChannel.onopen = (_) => dataChannelOpenPromise.resolve();
    handshakeDataChannel.onerror = (ev: Event) => {
      log.error('Error opening a data channel for handshaking: %s', ev.toString());
      dataChannelOpenPromise.reject(dataChannelError('noise', 'could not open handshake channel'));
    };
    setTimeout(() => {
      log.error('Data channel never opened. State was: %s', handshakeDataChannel.readyState.toString());
      dataChannelOpenPromise.reject(dataChannelError('noise', 'handshake channel opening timed out'));
    }, HANDSHAKE_TIMEOUT_MS);

    // create offer sdp
    let offerSdp = await peerConnection.createOffer();
    // generate random string for ufrag
    let ufrag = genUuid().replaceAll('-', '');
    // munge sdp with ufrag = pwd
    offerSdp = sdp.munge(offerSdp, ufrag);
    // set local description
    await peerConnection.setLocalDescription(offerSdp);
    // construct answer sdp from multiaddr
    let answerSdp = sdp.fromMultiAddr(ma, ufrag);
    // set remote description
    await peerConnection.setRemoteDescription(answerSdp);
    // wait for peerconnection.onopen to fire, or for the datachannel to open
    await dataChannelOpenPromise.promise;

    let myPeerId = await this.getPeerId();
    let theirPeerId = p.peerIdFromString(rps);

    // do noise handshake
    //set the Noise Prologue to libp2p-webrtc-noise:<FINGERPRINTS> before starting the actual Noise handshake.
    //  <FINGERPRINTS> is the concatenation of the of the two TLS fingerprints of A and B in their multihash byte representation, sorted in ascending order.
    let fingerprintsPrologue = this.generateNoisePrologue(peerConnection, ma);
    let noise = new Noise(undefined, undefined, undefined, fingerprintsPrologue);
    // let noise = new Noise(undefined, undefined, stablelib, fingerprintsPrologue);
    let wrappedChannel = new WebRTCStream({ channel: handshakeDataChannel, stat: { direction: 'outbound', timeline: { open: 1 } } });
    let wrappedDuplex = {
      ...wrappedChannel,
      source: {
        [Symbol.asyncIterator]: async function* () {
          for await (const list of wrappedChannel.source) {
            yield list.subarray();
          }
        },
      },
    };

    await noise.secureOutbound(myPeerId, wrappedDuplex, theirPeerId);

    return new WebRTCConnection({
      components: this.components!,
      id: ma.toString(),
      remoteAddr: ma,
      localPeer: myPeerId,
      direction: 'outbound',
      pc: peerConnection,
      remotePeer: theirPeerId,
    });
  }

  private generateNoisePrologue(pc: RTCPeerConnection, ma: Multiaddr): Uint8Array {
    if (pc.getConfiguration().certificates?.length === 0) {
      throw invalidArgument('no local certificate');
    }
    let localCert = pc.getConfiguration().certificates?.at(0)!;
    if (!localCert || localCert.getFingerprints().length === 0) {
      throw invalidArgument('no fingerprint on local certificate');
    }

    let localFingerprint = localCert.getFingerprints()[0];
    let localFpString = localFingerprint.value!.replaceAll(':', '');
    let localFpArray = uint8arrayFromString(localFpString, 'hex');
    let local: Uint8Array;
    switch (localFingerprint.algorithm!) {
      case 'md5':
        local = multihashes.encode(localFpArray, multihashes.names['md5']);
        break;
      case 'sha-256':
        local = multihashes.encode(localFpArray, multihashes.names['sha2-256']);
        break;
      case 'sha-512':
        local = multihashes.encode(localFpArray, multihashes.names['sha2-512']);
        break;
      default:
        throw unsupportedHashAlgorithm(localFingerprint.algorithm || 'none');
    }

    let remote: Uint8Array = sdp.mbdecoder.decode(sdp.certhash(ma));
    let prefix = uint8arrayFromString('libp2p-webrtc-noise:');
    let fps = [remote, local].sort(uint8arrayCompare);

    let result = concat([prefix, ...fps]);
    return result;
  }

  public async getPeerId(): Promise<PeerId> {
    await this.componentsPromise.promise;
    return this.components!.getPeerId();
  }
}

const WEBRTC_CODE: number = 280;
const CERTHASH_CODE: number = 466;

function validMa(ma: Multiaddr): boolean {
  let codes = ma.protoCodes();
  return codes.includes(WEBRTC_CODE) && codes.includes(CERTHASH_CODE) && ma.getPeerId() != null;
}
