# Temporary, anonymous probe of actual upstream service classes.
# No account cookies, audio, response bodies, tokens or request URLs are logged.
require 'json'
require 'net/http'
require 'uri'

class ProbeHttpError < StandardError
  attr_reader :status
  def initialize(status)
    @status = status
    super('upstream HTTP failure')
  end
end

module Muffon
  module Mixins
    module GlobalStorage; end
  end
  class Base
    def self.call(args = {})
      new(args).call
    end
    def initialize(args = {})
      @args = args
    end
    def check_args; end
    def credentials
      { deezer: { cookies: { arl: nil } } }
    end
    def test?
      false
    end
    def get_global_value(_key, **_options)
      $upstream_session ||= Deezer::Utils::SessionId.call
    end
    def proxy_data
      { uk: { ipv4: [nil] } }
    end
    def limit
      2
    end
    def offset
      0
    end
  end
  class Request
    def self.call(url:, method:, params: {}, payload: {}, cookies: {}, **_options)
      uri = URI(url)
      raise 'unexpected host' unless uri.scheme == 'https' && uri.host == 'www.deezer.com' && uri.port == 443
      uri.query = URI.encode_www_form(params || {})
      request = method == 'GET' ? Net::HTTP::Get.new(uri) : Net::HTTP::Post.new(uri)
      request['User-Agent'] = 'Mozilla/5.0 Deezer source comparison'
      request['Accept'] = 'application/json'
      request['Cookie'] = (cookies || {}).map { |key, value| "#{key}=#{value}" }.join('; ')
      if method == 'POST'
        request['Content-Type'] = payload.is_a?(String) ? 'application/json' : 'application/x-www-form-urlencoded'
        request.body = payload.is_a?(String) ? payload : URI.encode_www_form(payload || {})
      end
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 12, read_timeout: 20) { |client| client.request(request) }
      raise ProbeHttpError.new(response.code.to_i) unless response.code.to_i.between?(200, 299)
      JSON.parse(response.body)
    end
  end
end

root = ENV.fetch('MUFFON_CHECKOUT')
%w[
  app/services/deezer/base.rb
  app/services/deezer/utils/session_id.rb
  app/services/deezer/utils/token/user.rb
  app/services/deezer/search/base.rb
  app/services/deezer/search/tracks.rb
  app/services/deezer/track/base.rb
].each { |file| load File.join(root, file) }

def notice(message)
  puts "::notice title=Anonymous Deezer comparison::#{message}"
end

def safe_probe(label)
  yield
rescue ProbeHttpError => e
  notice("#{label}: HTTP #{e.status}")
rescue StandardError => e
  # Only the exception class is printed; exception messages may contain URLs.
  notice("#{label}: #{e.class.name}")
end

safe_probe('muffon gateway search') do
  service = Deezer::Search::Tracks.new(query: 'Daft Punk One More Time')
  rows = service.send(:raw_collection)
  raise 'invalid search response' unless rows.is_a?(Array)
  notice("muffon gateway search: response received; results=#{rows.length}")
end

safe_probe('muffon gateway metadata') do
  service = Deezer::Track::Base.new(track_id: '3135553')
  row = service.send(:raw_track_data)
  raise 'invalid track response' unless row.is_a?(Hash)
  notice("muffon gateway metadata: response received; exact_id=#{row['SNG_ID'].to_s == '3135553'}")
end
