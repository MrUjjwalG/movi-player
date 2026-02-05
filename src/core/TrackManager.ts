/**
 * TrackManager - Manages multi-track selection and switching
 */

import type { Track, VideoTrack, AudioTrack, SubtitleTrack } from '../types';
import { EventEmitter } from '../events/EventEmitter';
import { Logger } from '../utils/Logger';

const TAG = 'TrackManager';

interface TrackManagerEvents {
  videoTrackChange: VideoTrack | null;
  audioTrackChange: AudioTrack | null;
  subtitleTrackChange: SubtitleTrack | null;
  tracksChange: Track[];
}

export class TrackManager extends EventEmitter<TrackManagerEvents> {
  private tracks: Track[] = [];
  private activeVideoTrack: VideoTrack | null = null;
  private activeAudioTrack: AudioTrack | null = null;
  private activeSubtitleTrack: SubtitleTrack | null = null;
  
  /**
   * Set available tracks
   */
  setTracks(tracks: Track[]): void {
    this.tracks = [...tracks];
    
    // Auto-select first tracks of each type
    const videoTracks = this.getVideoTracks();
    const audioTracks = this.getAudioTracks();
    
    if (videoTracks.length > 0 && !this.activeVideoTrack) {
      this.activeVideoTrack = videoTracks[0];
    }
    
    if (audioTracks.length > 0 && !this.activeAudioTrack) {
      this.activeAudioTrack = audioTracks[0];
    }
    
    this.emit('tracksChange', this.tracks);
    Logger.info(TAG, `Tracks set: ${tracks.length} total`);
  }
  
  /**
   * Get all tracks
   */
  getTracks(): Track[] {
    return [...this.tracks];
  }
  
  /**
   * Get video tracks
   */
  getVideoTracks(): VideoTrack[] {
    return this.tracks.filter((t): t is VideoTrack => t.type === 'video');
  }
  
  /**
   * Get audio tracks
   */
  getAudioTracks(): AudioTrack[] {
    return this.tracks.filter((t): t is AudioTrack => t.type === 'audio');
  }
  
  /**
   * Get subtitle tracks
   */
  getSubtitleTracks(): SubtitleTrack[] {
    return this.tracks.filter((t): t is SubtitleTrack => t.type === 'subtitle');
  }
  
  /**
   * Get active video track
   */
  getActiveVideoTrack(): VideoTrack | null {
    return this.activeVideoTrack;
  }
  
  /**
   * Get active audio track
   */
  getActiveAudioTrack(): AudioTrack | null {
    return this.activeAudioTrack;
  }
  
  /**
   * Get active subtitle track
   */
  getActiveSubtitleTrack(): SubtitleTrack | null {
    return this.activeSubtitleTrack;
  }
  
  /**
   * Select video track
   */
  selectVideoTrack(trackId: number): boolean {
    const track = this.getVideoTracks().find(t => t.id === trackId);
    if (!track) {
      Logger.warn(TAG, `Video track ${trackId} not found`);
      return false;
    }
    
    if (this.activeVideoTrack?.id === trackId) {
      return true; // Already selected
    }
    
    this.activeVideoTrack = track;
    this.emit('videoTrackChange', track);
    Logger.info(TAG, `Selected video track: ${trackId}`);
    return true;
  }
  
  /**
   * Select audio track
   */
  selectAudioTrack(trackId: number): boolean {
    const track = this.getAudioTracks().find(t => t.id === trackId);
    if (!track) {
      Logger.warn(TAG, `Audio track ${trackId} not found`);
      return false;
    }
    
    if (this.activeAudioTrack?.id === trackId) {
      return true;
    }
    
    this.activeAudioTrack = track;
    this.emit('audioTrackChange', track);
    Logger.info(TAG, `Selected audio track: ${trackId}`);
    return true;
  }
  
  /**
   * Select subtitle track (null to disable)
   */
  selectSubtitleTrack(trackId: number | null): boolean {
    if (trackId === null) {
      this.activeSubtitleTrack = null;
      this.emit('subtitleTrackChange', null);
      Logger.info(TAG, 'Subtitles disabled');
      return true;
    }
    
    const track = this.getSubtitleTracks().find(t => t.id === trackId);
    if (!track) {
      Logger.warn(TAG, `Subtitle track ${trackId} not found`);
      return false;
    }
    
    if (this.activeSubtitleTrack?.id === trackId) {
      return true;
    }
    
    this.activeSubtitleTrack = track;
    this.emit('subtitleTrackChange', track);
    Logger.info(TAG, `Selected subtitle track: ${trackId}`);
    return true;
  }
  
  /**
   * Check if packet belongs to an active track
   */
  isActiveStream(streamIndex: number): boolean {
    return (
      this.activeVideoTrack?.id === streamIndex ||
      this.activeAudioTrack?.id === streamIndex ||
      this.activeSubtitleTrack?.id === streamIndex
    );
  }
  
  /**
   * Get track by ID
   */
  getTrackById(trackId: number): Track | undefined {
    return this.tracks.find(t => t.id === trackId);
  }
  
  /**
   * Clear all tracks
   */
  clear(): void {
    this.tracks = [];
    this.activeVideoTrack = null;
    this.activeAudioTrack = null;
    this.activeSubtitleTrack = null;
  }
}
