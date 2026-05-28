// encrypt/decrypt tool: AES-256-CTR, reads from stdin, writes nonce+encrypted to stdout
//
//	go run cmd/crypt/main.go < input > output.enc
//	go run cmd/crypt/main.go -d < input.enc > output
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"flag"
	"io"
	"os"
)

var key = [32]byte{
	0x8f, 0x2a, 0x4b, 0x6c, 0x9d, 0x1e, 0x3f, 0x5a,
	0x7b, 0x8d, 0x0e, 0x2f, 0x4a, 0x6c, 0x8e, 0x1a,
	0x2c, 0x4e, 0x6f, 0x8a, 0x0b, 0x2d, 0x4f, 0x6e,
	0x8a, 0x0c, 0x2e, 0x4a, 0x6e, 0x8a, 0x0b, 0x0c,
}

func main() {
	decrypt := flag.Bool("d", false, "decrypt mode")
	flag.Parse()

	block, err := aes.NewCipher(key[:])
	if err != nil {
		panic(err)
	}

	if *decrypt {
		nonce := make([]byte, 16)
		if _, err := io.ReadFull(os.Stdin, nonce); err != nil {
			panic(err)
		}
		stream := cipher.NewCTR(block, nonce)
		reader := cipher.StreamReader{S: stream, R: os.Stdin}
		io.Copy(os.Stdout, reader)
	} else {
		nonce := make([]byte, 16)
		if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
			panic(err)
		}
		os.Stdout.Write(nonce)
		stream := cipher.NewCTR(block, nonce)
		writer := cipher.StreamWriter{S: stream, W: os.Stdout}
		io.Copy(writer, os.Stdin)
	}
}
