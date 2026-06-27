# Place this file at Formula/plaudpoller.rb in a repo named homebrew-plaud
# (github.com/shokk/homebrew-plaud)
#
# Users install with:
#   brew tap shokk/plaud
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/PlaudPoller"
  version "1.0.9"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "9e4fc4d2f0ede3f302c952109ee04978a38313962a2edb507b1c8b90f02646e1"
    else
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "1d220e17307348b59526c0175b4854981a2aac24aa48c338de2809384a8fae94"
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
