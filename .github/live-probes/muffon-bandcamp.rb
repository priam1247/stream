# Temporary live probe of the supplied Muffon Bandcamp service classes.
# Actual service code supplies the API request, parameters and stream extraction;
# this harness only supplies the HTTP transport and skips Muffon's proxy config.
require 'json'
require 'net/http'
require 'uri'
require 'fileutils'

module Muffon
  class Base
    def initialize(**args); @args = args; end
  end
  module Mixins; module Formatting; module Collection; end; end; end
  class Request
    def self.call(url:, method:, params: nil, payload: nil, proxy: nil)
      uri = URI(url)
      uri.query = URI.encode_www_form(params) if params
      klass = method == 'POST' ? Net::HTTP::Post : Net::HTTP::Get
      req = klass.new(uri.request_uri)
      req['User-Agent'] = 'Mozilla/5.0 (compatible; public media test)'
      req['Content-Type'] = 'application/json' if payload
      req.body = JSON.generate(payload) if payload
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 15, read_timeout: 30) { |http| http.request(req) }
      raise "HTTP_#{response.code}" unless response.is_a?(Net::HTTPSuccess)
      JSON.parse(response.body)
    end
  end
end
root = '/tmp/muffon-resource/app/services'
load "#{root}/bandcamp/base.rb"
load "#{root}/bandcamp/mixins/track.rb"
load "#{root}/bandcamp/search/base.rb"
load "#{root}/bandcamp/search/tracks.rb"
load "#{root}/bandcamp/track/base.rb"
module Bandcamp
  class Base
    private
    def request_proxy; nil; end
  end
end

def note(message)
  puts "::notice title=Muffon Bandcamp live::#{message}"
end

begin
  search = Bandcamp::Search::Tracks.new(query: 'Alexander Nakarada Circuits')
  rows = search.send(:response_data).dig('auto', 'results') || []
  note("actual search returned #{rows.length} results")
  chosen = rows.find { |row| row['band_id'].to_s == '2253961622' && row['name'].to_s.downcase.include?('circuits') }
  unless chosen
    note("matching CC BY track not found; safe keys=#{rows.first&.keys&.join(',')}")
    exit 1
  end
  # Creator's own track page declares CC BY 4.0.
  page = URI('https://alexandernakarada.bandcamp.com/track/circuits-3')
  html = Net::HTTP.start(page.host, page.port, use_ssl: true, open_timeout: 15, read_timeout: 30) { |http| http.get(page.request_uri).body }
  raise 'TRACK_LICENSE_NOT_CONFIRMED' unless html.include?('creativecommons.org/licenses/by/4.0')
  track = Bandcamp::Track::Base.new(artist_id: chosen['band_id'], track_id: chosen['id'])
  raw = track.send(:response_data)
  url = track.send(:audio_link)
  raise 'NO_AUDIO' unless url.to_s.start_with?('https://')
  note("actual Muffon track resolver returned audio; declared duration #{raw.dig('tracks', 0, 'duration').to_i} seconds")
  uri = URI(url)
  path = '/tmp/muffon-bandcamp-sample.mp3'
  bytes = 0
  Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 15, read_timeout: 40) do |http|
    http.request(Net::HTTP::Get.new(uri.request_uri)) do |response|
      raise "AUDIO_HTTP_#{response.code}" unless response.is_a?(Net::HTTPSuccess)
      File.open(path, 'wb') do |file|
        response.read_body do |chunk|
          bytes += chunk.bytesize
          raise 'TOO_LARGE' if bytes > 30 * 1024 * 1024
          file.write(chunk)
        end
      end
    end
  end
  raise 'TOO_SMALL' unless bytes > 10_000
  ok = system(ENV.fetch('FFMPEG_PATH'), '-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'null', '-', out: File::NULL, err: File::NULL)
  raise 'DECODE_FAILED' unless ok
  note("actual Muffon Bandcamp CC BY track fully downloaded and decoded, #{bytes} bytes")
rescue => e
  # Do not print signed URLs, response bodies, request headers, or exception text.
  note("probe failed safely (#{e.class})")
  exit 1
ensure
  FileUtils.rm_f('/tmp/muffon-bandcamp-sample.mp3')
end
