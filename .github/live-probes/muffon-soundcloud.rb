# Temporary live check using actual Muffon SoundCloud classes. Only a creator's
# explicit CC BY sample is fetched, and no returned keys or signed paths are logged.
require 'json'
require 'net/http'
require 'uri'
require 'fileutils'
class String; alias starts_with? start_with?; end
module Muffon
  class Base
    def initialize(**args); @args = args; end
    private
    def limit; 50; end
    def offset; 0; end
  end
  module Mixins; module GlobalStorage; end; end
  class Document
    Script = Struct.new(:text)
    def initialize(html); @html = html; end
    def css(_tag); @html.scan(/<script\b[^>]*>(.*?)<\/script>/im).map { |match| Script.new(match.first) }; end
  end
  class Request
    def self.call(url:, method:, params: nil, response_type: nil, **_rest)
      uri = URI(url)
      uri.query = URI.encode_www_form(params) if params
      request = Net::HTTP::Get.new(uri.request_uri)
      request['User-Agent'] = 'Mozilla/5.0 (compatible; public media test)'
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 15, read_timeout: 35) { |http| http.request(request) }
      raise "HTTP_#{response.code}" unless response.is_a?(Net::HTTPSuccess)
      response_type == 'html' ? Document.new(response.body) : JSON.parse(response.body)
    end
  end
end
root = '/tmp/muffon-resource/app/services'
load "#{root}/soundcloud/base.rb"
load "#{root}/soundcloud/utils/client_id.rb"
load "#{root}/soundcloud/search/base.rb"
load "#{root}/soundcloud/search/tracks.rb"
load "#{root}/soundcloud/utils/track/audio/link.rb"
module SoundCloud
  class Base
    private
    def request_proxy; nil; end
    def client_id; $muffon_guest_client_id; end
  end
end

def note(message); puts "::notice title=Muffon SoundCloud live::#{message}"; end
begin
  # Real Muffon extracts the public app id from the site's hydration script.
  $muffon_guest_client_id = SoundCloud::Utils::ClientId.new.call
  raise 'NO_GUEST_CLIENT' if $muffon_guest_client_id.to_s.empty?
  note('actual Muffon guest client bootstrap succeeded')
  search = SoundCloud::Search::Tracks.new(query: 'Alexander Nakarada Fireworks')
  rows = search.send(:response_data)['collection'] || []
  note("actual search returned #{rows.length} results")
  track = rows.find { |row| row['permalink_url'] == 'https://soundcloud.com/creatorchords/fireworks' }
  raise 'MATCH_NOT_FOUND' unless track
  raise 'LICENSE_NOT_CONFIRMED' unless track['license'] == 'cc-by'
  link = SoundCloud::Utils::Track::Audio::Link.new(raw_track_data: track)
  raise 'NO_PROGRESSIVE_AUDIO' unless link.send(:audio_link_data)
  media = link.send(:data)
  raise 'NO_AUDIO' unless media.to_s.start_with?('https://')
  note('actual Muffon progressive audio resolver returned a URL for the CC BY sample')
  uri = URI(media)
  file = '/tmp/muffon-soundcloud-sample.mp3'
  bytes = 0
  4.times do |redirect|
    raise 'UNEXPECTED_AUDIO_HOST' unless uri.scheme == 'https' && (uri.host == 'sndcdn.com' || uri.host.end_with?('.sndcdn.com'))
    target = nil
    Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 15, read_timeout: 45) do |http|
      http.request(Net::HTTP::Get.new(uri.request_uri)) do |response|
        if response.is_a?(Net::HTTPRedirection) && redirect < 3 && response['location']
          target = URI.join(uri, response['location'])
          response.read_body { |_chunk| }
        else
          raise "AUDIO_HTTP_#{response.code}" unless response.is_a?(Net::HTTPSuccess)
          File.open(file, 'wb') do |out|
            response.read_body do |chunk|
              bytes += chunk.bytesize
              raise 'TOO_LARGE' if bytes > 30 * 1024 * 1024
              out.write(chunk)
            end
          end
        end
      end
    end
    break unless target
    uri = target
  end
  raise 'TOO_SMALL' unless bytes > 10_000
  raise 'DECODE_FAILED' unless system(ENV.fetch('FFMPEG_PATH'), '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'null', '-', out: File::NULL, err: File::NULL)
  note("actual Muffon SoundCloud CC BY sample fully downloaded and decoded, #{bytes} bytes")
rescue => e
  reason = e.message.to_s.match?(/\A(?:HTTP_\d{3}|AUDIO_HTTP_\d{3}|NO_GUEST_CLIENT|MATCH_NOT_FOUND|LICENSE_NOT_CONFIRMED|NO_PROGRESSIVE_AUDIO|NO_AUDIO|UNEXPECTED_AUDIO_HOST|TOO_LARGE|TOO_SMALL|DECODE_FAILED)\z/) ? e.message : e.class.to_s
  note("probe failed safely (#{reason})")
  exit 1
ensure
  FileUtils.rm_f('/tmp/muffon-soundcloud-sample.mp3')
end
