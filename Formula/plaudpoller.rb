# Formula/plaudpoller.rb — part of github.com/shokk/homebrew-plaudpoller
#
# Users install with:
#   brew tap shokk/plaudpoller
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/homebrew-plaudpoller"
  version "1.1.6"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "1bda5bb4163a7d5381eee356aba06f8910411b3dbd38fe494c71bb45cc65409d"
    else
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "085c36fce2165ea0322007e17708ee1b3415a406e65a1fc07eb11d1cf001b214"
    end
  end

  def install
    binary = Hardware::CPU.arm? ? "plaudpoller-arm64" : "plaudpoller-x64"
    bin.install binary => "plaudpoller"
  end

  test do
    assert_match "Usage: plaudpoller", shell_output("#{bin}/plaudpoller 2>&1", 0)
  end
end
