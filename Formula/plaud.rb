# Place this file at Formula/plaud.rb in a repo named homebrew-plaud
# (github.com/eoporto/homebrew-plaud)
#
# Users install with:
#   brew tap eoporto/plaud
#   brew install plaud

class Plaud < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/PlaudPoller"
  version "1.0.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaud-arm64"
      sha256 "3c444e64a9566aaa04b5d4b4044362b1ecc3f492159f219a04962a7c96a7a5f7"
    else
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaud-x64"
      sha256 "09f67f29f30c258b9cd407c1cf35f86bc94ffb322f481d78903368c1635a10ab"
    end
  end

  def install
    binary = Hardware::CPU.arm? ? "plaud-arm64" : "plaud-x64"
    bin.install binary => "plaud"
  end

  test do
    assert_match "Usage: plaud", shell_output("#{bin}/plaud 2>&1", 0)
  end
end
